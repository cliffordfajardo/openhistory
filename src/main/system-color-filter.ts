import type { FocusSystemFilterState } from "@shared/focus";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { writePrivateFile } from "./private-storage";

/** macOS Color Filters settings: whether they're on and which filter (1 is grayscale). */
export interface SystemColorFilterSettings {
  enabled: boolean;
  type: number;
}

/**
 * The private MediaAccessibility calls. Where they can't be loaded, `read` returns null and
 * `write` false. Both change or report the persisted setting only, never on-screen timing.
 */
export interface SystemColorFilterBinding {
  read(): SystemColorFilterSettings | null;
  write(settings: SystemColorFilterSettings): boolean;
}

export const SYSTEM_GRAYSCALE: SystemColorFilterSettings = { enabled: true, type: 1 };

const MAX_JOURNAL_BYTES = 4_096;

const SettingsSchema = z.object({
  enabled: z.boolean(),
  type: z.number().int().min(0).max(0x7fff_ffff)
});

const JournalSchema = z.object({
  version: z.literal(1),
  baseline: SettingsSchema.strict(),
  applied: SettingsSchema.strict(),
  writtenAt: z.string().max(40)
}).strict();

interface Journal {
  /** Null when an unreadable journal left the earlier settings unknown. */
  baseline: SystemColorFilterSettings | null;
  applied: SystemColorFilterSettings;
}

export interface SystemColorFilterOptions {
  binding: SystemColorFilterBinding | undefined;
  /** Kept outside the deletable data root so deleting data can't drop it before colors return. */
  journalPath: string;
  now?: () => number;
}

function same(left: SystemColorFilterSettings, right: SystemColorFilterSettings): boolean {
  return left.enabled === right.enabled && left.type === right.type;
}

/**
 * The single owner of system grayscale. Every call is synchronous, so there is nothing to queue.
 *
 * Before the first turn-on the current settings are read and journaled privately; only then is
 * grayscale written. Restoring preserves a manual change to the filter type or enabled state;
 * when the person only turned filters off, it also puts back the type this app displaced. Settings
 * that were already grayscale are left alone and nothing is journaled. A readable journal left by
 * an earlier launch is restored when this owner is created. An unreadable journal cannot reveal
 * the original settings, so it remains unresolved while grayscale is still selected.
 */
export class SystemColorFilterController {
  private phase: FocusSystemFilterState["phase"] = "idle";
  private failure: FocusSystemFilterState["failure"] = null;
  private journal: Journal | null;
  private supported: boolean;
  private closing = false;
  private readonly now: () => number;

  constructor(private readonly options: SystemColorFilterOptions) {
    this.now = options.now ?? Date.now;
    this.journal = this.readJournal();
    this.supported = this.read() !== null;
    if (!this.supported) this.phase = "unsupported";
    if (this.journal) this.restore();
  }

  get available(): boolean {
    return this.supported;
  }

  view(): FocusSystemFilterState {
    return {
      available: this.supported,
      phase: this.phase,
      failure: this.failure,
      restorePending: this.journal !== null
    };
  }

  /** Switches Color Filters to grayscale. True when grayscale is on afterwards. */
  apply(): boolean {
    if (this.closing || this.phase === "unsupported" || this.phase === "restore_failed") return false;
    if (this.phase === "applied") {
      const current = this.read();
      if (current && same(current, this.journal?.applied ?? SYSTEM_GRAYSCALE)) return true;
      // A manual change during this reminder must not be undone by another apply call.
      this.restore();
      return this.applyFailed("apply_failed");
    }
    const baseline = this.read();
    if (!baseline) return this.applyFailed("apply_failed");
    if (same(baseline, SYSTEM_GRAYSCALE)) {
      this.failure = null;
      return true;
    }
    if (!this.writeJournal({ baseline, applied: SYSTEM_GRAYSCALE })) return this.applyFailed("journal_unwritable");
    this.phase = "applied";
    if (this.write(SYSTEM_GRAYSCALE)) {
      this.failure = null;
      return true;
    }
    // The write may have changed part of the setting; put the earlier settings back.
    const current = this.read();
    if (current && (same(current, baseline) || this.write(baseline))) this.release();
    else this.phase = "restore_failed";
    return this.applyFailed("apply_failed");
  }

  /**
   * Puts back the settings saved before this app's turn-on. True when nothing is left to restore.
   * A failure keeps the journal, so the next attempt or launch tries again.
   */
  restore(): boolean {
    const journal = this.journal;
    if (!journal) {
      if (this.phase === "applied") this.phase = "idle";
      return true;
    }
    const current = this.read();
    if (!current) {
      this.phase = "restore_failed";
      return false;
    }
    if (!journal.baseline) {
      // An invalid journal does not tell us whether grayscale was already the person's choice.
      // Leave it unresolved for manual recovery rather than blindly turning their filters off.
      if (same(current, journal.applied)) {
        this.phase = "restore_failed";
        return false;
      }
      this.release();
      return true;
    }
    if (same(current, journal.applied)) {
      if (!this.write(journal.baseline)) {
        this.phase = "restore_failed";
        return false;
      }
    } else if (current.type === journal.applied.type &&
               journal.applied.enabled && !current.enabled &&
               current.type !== journal.baseline.type) {
      // The person turned filters off, but our temporary grayscale type is still selected.
      // Restore only that type; never re-enable a filter the person just disabled.
      if (!this.write({ enabled: false, type: journal.baseline.type })) {
        this.phase = "restore_failed";
        return false;
      }
    }
    // Other type changes belong to the person and are left intact.
    this.release();
    return true;
  }

  /** Restores before quit or data deletion; afterwards nothing turns grayscale on again. */
  shutdown(): void {
    this.closing = true;
    this.restore();
  }

  private applyFailed(failure: NonNullable<FocusSystemFilterState["failure"]>): false {
    this.failure = failure;
    return false;
  }

  private release(): void {
    this.removeJournal();
    this.phase = "idle";
  }

  private read(): SystemColorFilterSettings | null {
    try {
      const parsed = SettingsSchema.safeParse(this.options.binding?.read());
      if (!parsed.success) return null;
      this.supported = true;
      if (this.phase === "unsupported") this.phase = "idle";
      return parsed.data;
    } catch {
      return null;
    }
  }

  private write(settings: SystemColorFilterSettings): boolean {
    try {
      return this.options.binding?.write({ ...settings }) === true;
    } catch {
      return false;
    }
  }

  private writeJournal(journal: Journal): boolean {
    try {
      writePrivateFile(this.options.journalPath, `${JSON.stringify({
        version: 1,
        baseline: journal.baseline,
        applied: journal.applied,
        writtenAt: new Date(this.now()).toISOString()
      })}\n`);
    } catch (error) {
      console.error("Unable to record the Color Filters restore journal", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
      return false;
    }
    this.journal = journal;
    return true;
  }

  private removeJournal(): void {
    try {
      rmSync(this.options.journalPath, { force: true });
      this.journal = null;
    } catch (error) {
      console.error("Unable to remove the Color Filters restore journal", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  private readJournal(): Journal | null {
    const path = this.options.journalPath;
    if (!existsSync(path)) return null;
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && stat.isFile() && stat.size <= MAX_JOURNAL_BYTES) {
        const journal = JournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        return { baseline: journal.baseline, applied: journal.applied };
      }
    } catch {
    }
    return { baseline: null, applied: SYSTEM_GRAYSCALE };
  }
}
