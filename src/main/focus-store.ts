import { FOCUS_LIMITS, type FocusPreferences, type Goal, type GoalDraft } from "@shared/focus";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { FocusDocumentSchema, type FocusDocument } from "./focus-schemas";
import { writePrivateFile } from "./private-storage";

export const DEFAULT_FOCUS_PREFERENCES: FocusPreferences = {
  domains: [],
  durationMinutes: 25
};

const MAX_FOCUS_FILE_BYTES = 512 * 1_024;

function defaultDocument(): FocusDocument {
  return {
    version: 1,
    goals: [],
    selectedGoalId: null,
    preferences: structuredClone(DEFAULT_FOCUS_PREFERENCES)
  };
}

/**
 * Goals and Focus preferences, stored as one private JSON file inside the owned activity-data
 * root so "Delete all local data" removes them. Sessions are deliberately not stored here: an
 * active session lives only in memory and never resumes after a restart.
 */
export class FocusStore {
  readonly path: string;
  private document: FocusDocument;
  private recovered = false;

  constructor(
    dataDirectory: string,
    private readonly createId: () => string = () => `goal-${randomUUID()}`,
    private readonly now: () => number = Date.now
  ) {
    this.path = resolve(dataDirectory, "focus.json");
    this.document = this.read();
  }

  get recoveredFromInvalidFile(): boolean {
    return this.recovered;
  }

  load(): FocusDocument {
    return structuredClone(this.document);
  }

  goal(id: string): Goal | undefined {
    const goal = this.document.goals.find((candidate) => candidate.id === id);
    return goal ? structuredClone(goal) : undefined;
  }

  saveGoal(draft: GoalDraft): { document: FocusDocument; goal: Goal } {
    const goals = [...this.document.goals];
    let goal: Goal;
    if (draft.id) {
      const index = goals.findIndex((candidate) => candidate.id === draft.id);
      if (index < 0) throw new Error("That goal no longer exists");
      goal = { id: draft.id, title: draft.title, why: draft.why, currentFocus: draft.currentFocus };
      goals[index] = goal;
    } else {
      if (goals.length >= FOCUS_LIMITS.goals) {
        throw new Error(`You can keep up to ${FOCUS_LIMITS.goals} goals`);
      }
      goal = { id: this.createId(), title: draft.title, why: draft.why, currentFocus: draft.currentFocus };
      goals.push(goal);
    }
    const document = this.write({
      ...this.document,
      goals,
      selectedGoalId: this.document.selectedGoalId ?? goal.id
    });
    const saved = document.goals.find((candidate) => candidate.id === goal.id)!;
    return { document, goal: structuredClone(saved) };
  }

  deleteGoal(id: string): FocusDocument {
    if (!this.document.goals.some((goal) => goal.id === id)) throw new Error("That goal no longer exists");
    const goals = this.document.goals.filter((goal) => goal.id !== id);
    return this.write({
      ...this.document,
      goals,
      selectedGoalId: this.document.selectedGoalId === id ? (goals[0]?.id ?? null) : this.document.selectedGoalId
    });
  }

  selectGoal(id: string | null): FocusDocument {
    if (id !== null && !this.document.goals.some((goal) => goal.id === id)) {
      throw new Error("That goal no longer exists");
    }
    return this.write({ ...this.document, selectedGoalId: id });
  }

  savePreferences(preferences: FocusPreferences): FocusDocument {
    return this.write({ ...this.document, preferences });
  }

  private write(next: FocusDocument): FocusDocument {
    const normalized = FocusDocumentSchema.parse(next);
    writePrivateFile(this.path, `${JSON.stringify(normalized, null, 2)}\n`);
    this.document = normalized;
    return structuredClone(normalized);
  }

  private read(): FocusDocument {
    if (!existsSync(this.path)) return defaultDocument();
    try {
      if (lstatSync(this.path).isSymbolicLink()) throw new Error("Focus file cannot be a symbolic link");
      if (lstatSync(this.path).size > MAX_FOCUS_FILE_BYTES) throw new Error("Focus file is too large");
      const document = FocusDocumentSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      if (document.selectedGoalId && !document.goals.some((goal) => goal.id === document.selectedGoalId)) {
        document.selectedGoalId = null;
      }
      return document;
    } catch (error) {
      console.error("Unable to read Focus goals; starting with empty goals", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
      this.preserveInvalidFile();
      this.recovered = true;
      return defaultDocument();
    }
  }

  private preserveInvalidFile(): void {
    try {
      renameSync(this.path, `${this.path}.invalid-${this.now()}`);
    } catch (error) {
      console.error("Unable to preserve the unreadable Focus file", {
        name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }
}
