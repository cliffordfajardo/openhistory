import type { BootstrapState, CollectionSettings } from "@shared/contracts";
import {
  FOCUS_DURATION_PRESETS,
  FOCUS_LIMITS,
  FOCUS_TIMING,
  parseFocusDomain,
  type FocusDetectionState,
  type FocusForegroundSummary,
  type FocusViewState
} from "@shared/focus";
import { useEffect, useMemo, useState } from "react";
import {
  InlineError,
  focusAction,
  formatClock,
  formatRemaining,
  readableError,
  useNow,
  type SetAppState
} from "./shared";

const DETECTION_COPY: Record<FocusDetectionState, { label: string; detail: string }> = {
  ready: {
    label: "Ready to notice listed sites",
    detail: "During a session, OpenHistory Focus checks the front browser tab using the same private capture it already runs."
  },
  capture_paused: {
    label: "Capture is paused",
    detail: "Reminders need capture running. Nothing is observed while paused, so no reminder can appear."
  },
  needs_privacy_notice: {
    label: "Finish setup first",
    detail: "Accept the privacy notice to let OpenHistory Focus observe the front app."
  },
  needs_accessibility: {
    label: "Accessibility access needed",
    detail: "macOS Accessibility access is how the front browser's address is read. Without it, Focus can't tell which site is open."
  },
  url_capture_off: {
    label: "Browser addresses are off",
    detail: "Focus compares the front tab's site with your list. Turn on Browser URLs in Settings to allow reminders."
  },
  collector_unavailable: {
    label: "Capture isn't running",
    detail: "The activity collector couldn't start. Reminders stay off until it does."
  },
  overlay_unavailable: {
    label: "Reminder surface unavailable",
    detail: "This build is missing the native reminder. Rebuild the native bridge to enable reminders."
  }
};

const FOREGROUND_COPY: Record<FocusForegroundSummary, string> = {
  not_watching: "Not watching — no session is running.",
  waiting: "Waiting for the first check…",
  listed_site: "A listed site is in front.",
  other_site: "A browser is in front on a site that isn't listed.",
  other_app: "Another app is in front.",
  address_unavailable: "The browser address is unreadable. No reminder will show until it is available.",
  protected_context: "A private or protected context was detected. Reminders are withheld.",
  excluded_app: "The foreground app is excluded from capture.",
  idle: "Reminders are quiet while you’re away. They resume when you use the Mac.",
  locked: "The screen is locked. Reminders are quiet.",
  asleep: "The display is asleep. Reminders are quiet.",
  unknown: "The current foreground is uncertain. No reminder will show until the next fresh check."
};

export function FocusPage({
  onManageGoals,
  onOpenSettings,
  setState,
  state
}: {
  onManageGoals: () => void;
  onOpenSettings: () => void;
  setState: SetAppState;
  state: BootstrapState;
}): React.JSX.Element {
  const focus = state.focus;
  return (
    <section className="page-stack focus-page" aria-label="Focus">
      {focus.recoveredFromInvalidFile ? (
        <div className="notice" role="status">
          Your saved goals couldn’t be read, so Focus started fresh. The unreadable file was kept beside the new one in your data folder.
        </div>
      ) : null}
      {focus.session.status === "active"
        ? <ActiveSessionCard focus={focus} setState={setState} />
        : <StartSessionCard focus={focus} onManageGoals={onManageGoals} setState={setState} />}
      <DistractingSitesCard focus={focus} setState={setState} />
      <DetectionCard focus={focus} onOpenSettings={onOpenSettings} setState={setState} state={state} />
    </section>
  );
}

function StartSessionCard({
  focus,
  onManageGoals,
  setState
}: {
  focus: FocusViewState;
  onManageGoals: () => void;
  setState: SetAppState;
}): React.JSX.Element {
  const selectedGoal = focus.goals.find((goal) => goal.id === focus.selectedGoalId) ?? focus.goals[0];
  const [intention, setIntention] = useState(selectedGoal?.currentFocus ?? "");
  const preset = (FOCUS_DURATION_PRESETS as readonly number[]).includes(focus.preferences.durationMinutes);
  const [durationMode, setDurationMode] = useState<"preset" | "custom">(preset ? "preset" : "custom");
  const [duration, setDuration] = useState(focus.preferences.durationMinutes);
  const [customDuration, setCustomDuration] = useState(String(focus.preferences.durationMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [previewMessage, setPreviewMessage] = useState<string>();

  useEffect(() => {
    setIntention(selectedGoal?.currentFocus ?? "");
  }, [selectedGoal?.id]);

  const customValue = Number(customDuration);
  const customValid = Number.isInteger(customValue) &&
    customValue >= FOCUS_LIMITS.minimumDurationMinutes &&
    customValue <= FOCUS_LIMITS.maximumDurationMinutes;
  const effectiveDuration = durationMode === "custom" ? customValue : duration;
  const noSites = focus.preferences.domains.length === 0;
  const canStart = Boolean(selectedGoal) && !noSites && (durationMode === "preset" || customValid) && !busy;

  async function selectGoal(id: string): Promise<void> {
    setError(await focusAction(setState, () => window.openHistory.selectGoal(id)));
  }

  async function start(): Promise<void> {
    if (!selectedGoal || !canStart) return;
    setBusy(true);
    setError(await focusAction(setState, () => window.openHistory.startFocus({
      goalId: selectedGoal.id,
      intention,
      durationMinutes: effectiveDuration
    })));
    setBusy(false);
  }

  async function preview(): Promise<void> {
    setPreviewMessage(undefined);
    const failure = await focusAction(setState, () => window.openHistory.previewFocusReminder());
    setPreviewMessage(failure ?? "Preview shown on this display for about 8 seconds.");
  }

  if (focus.goals.length === 0) {
    return (
      <div className="card focus-hero">
        <span className="eyebrow focus-eyebrow">Focus session</span>
        <h2>Start with a goal</h2>
        <p className="focus-lede">A goal gives each reminder a reason: what you’re working toward and why it matters.</p>
        <div className="focus-actions">
          <button className="primary-button" onClick={onManageGoals} type="button">Create a goal</button>
          <button className="secondary-button" onClick={() => void preview()} type="button">Test reminder</button>
        </div>
        {previewMessage ? <p className="focus-quiet" role="status">{previewMessage}</p> : null}
      </div>
    );
  }

  return (
    <form
      className="card focus-hero"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <span className="eyebrow focus-eyebrow">Focus session</span>
      <h2>What are you working on?</h2>

      <div className="focus-field">
        <label htmlFor="focus-goal">Goal</label>
        <div className="focus-goal-row">
          <select
            id="focus-goal"
            onChange={(event) => void selectGoal(event.target.value)}
            value={selectedGoal?.id ?? ""}
          >
            {focus.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
          </select>
          <button className="focus-link-button" onClick={onManageGoals} type="button">Manage goals</button>
        </div>
        {selectedGoal?.why ? <p className="focus-why">{selectedGoal.why}</p> : null}
      </div>

      <div className="focus-field">
        <label htmlFor="focus-intention">This session, I’ll…</label>
        <textarea
          id="focus-intention"
          maxLength={FOCUS_LIMITS.intention}
          onChange={(event) => setIntention(event.target.value)}
          placeholder="Draft the outline for section two"
          rows={2}
          value={intention}
        />
      </div>

      <fieldset className="focus-field focus-duration">
        <legend>Duration</legend>
        <div className="focus-segmented" role="radiogroup" aria-label="Session duration">
          {FOCUS_DURATION_PRESETS.map((minutes) => (
            <button
              aria-checked={durationMode === "preset" && duration === minutes}
              className={durationMode === "preset" && duration === minutes ? "active" : ""}
              key={minutes}
              onClick={() => {
                setDurationMode("preset");
                setDuration(minutes);
              }}
              role="radio"
              type="button"
            >
              {minutes} min
            </button>
          ))}
          <button
            aria-checked={durationMode === "custom"}
            className={durationMode === "custom" ? "active" : ""}
            onClick={() => setDurationMode("custom")}
            role="radio"
            type="button"
          >
            Custom
          </button>
        </div>
        {durationMode === "custom" ? (
          <label className="focus-custom-duration">
            <input
              aria-label="Custom duration in minutes"
              inputMode="numeric"
              max={FOCUS_LIMITS.maximumDurationMinutes}
              min={FOCUS_LIMITS.minimumDurationMinutes}
              onChange={(event) => setCustomDuration(event.target.value)}
              type="number"
              value={customDuration}
            />
            <span>minutes</span>
            {!customValid ? (
              <small>Choose {FOCUS_LIMITS.minimumDurationMinutes}–{FOCUS_LIMITS.maximumDurationMinutes} minutes.</small>
            ) : null}
          </label>
        ) : null}
      </fieldset>

      {noSites ? <p className="focus-quiet">Add at least one distracting site below to start a session.</p> : null}
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="focus-actions">
        <button className="primary-button focus-start" disabled={!canStart} type="submit">
          {busy ? "Starting…" : "Start focus"}
        </button>
        <button className="secondary-button" onClick={() => void preview()} type="button">Test reminder</button>
      </div>
      {previewMessage ? <p className="focus-quiet" role="status">{previewMessage}</p> : null}
      <p className="focus-honest-note">
        Focus is a gentle nudge, not a blocker. When a listed site is in front, a soft amber edge and a short reminder appear. Every site stays reachable.
      </p>
    </form>
  );
}

function ActiveSessionCard({
  focus,
  setState
}: {
  focus: FocusViewState;
  setState: SetAppState;
}): React.JSX.Element {
  const session = focus.session.status === "active" ? focus.session : undefined;
  const now = useNow(Boolean(session));
  const [error, setError] = useState<string>();
  const [previewMessage, setPreviewMessage] = useState<string>();
  if (!session) return <></>;
  const startedAt = Date.parse(session.startedAt);
  const endsAt = Date.parse(session.endsAt);
  const remaining = endsAt - now;
  const progress = Math.min(1, Math.max(0, (now - startedAt) / Math.max(1, endsAt - startedAt)));
  const snoozedUntil = session.snoozedUntil ? Date.parse(session.snoozedUntil) : undefined;
  const snoozed = snoozedUntil !== undefined && snoozedUntil > now;

  async function run(action: () => Promise<FocusViewState>): Promise<void> {
    setError(await focusAction(setState, action));
  }

  async function preview(): Promise<void> {
    setPreviewMessage(undefined);
    const failure = await focusAction(setState, () => window.openHistory.previewFocusReminder());
    setPreviewMessage(failure ?? "Preview shown on this display for about 8 seconds.");
  }

  return (
    <div className="card focus-hero is-active">
      <div className="focus-active-heading">
        <span className="eyebrow focus-eyebrow">Focusing</span>
        <span className="focus-ends">Ends at {formatClock(endsAt)}</span>
      </div>
      <div className="focus-remaining" aria-label={`${formatRemaining(remaining)} remaining`}>
        {formatRemaining(remaining)}
      </div>
      <div
        aria-label="Session progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(progress * 100)}
        className="focus-progress"
        role="progressbar"
      >
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="focus-session-copy">
        <strong>{session.goal.title}</strong>
        {session.intention ? <p>{session.intention}</p> : null}
      </div>
      {snoozed ? (
        <p className="focus-quiet" role="status">Reminders snoozed until {formatClock(snoozedUntil!)}.</p>
      ) : null}
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="focus-actions">
        <button className="primary-button" onClick={() => void run(() => window.openHistory.stopFocus())} type="button">
          Stop session
        </button>
        {snoozed ? (
          <button className="secondary-button" onClick={() => void run(() => window.openHistory.resumeFocus())} type="button">
            Resume reminders
          </button>
        ) : (
          <button className="secondary-button" onClick={() => void run(() => window.openHistory.snoozeFocus())} type="button">
            Snooze 5 min
          </button>
        )}
        <button className="secondary-button" onClick={() => void preview()} type="button">Test reminder</button>
      </div>
      {previewMessage ? <p className="focus-quiet" role="status">{previewMessage}</p> : null}
      <p className="focus-honest-note">
        Watching {session.domains.length} {session.domains.length === 1 ? "site" : "sites"}. Reminders are gentle and never block anything. Sessions don’t resume after the app restarts.
      </p>
    </div>
  );
}

function DistractingSitesCard({
  focus,
  setState
}: {
  focus: FocusViewState;
  setState: SetAppState;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const domains = focus.preferences.domains;
  const sessionActive = focus.session.status === "active";

  async function save(nextDomains: string[]): Promise<boolean> {
    setSaving(true);
    try {
      const next = await window.openHistory.saveFocusPreferences({
        ...focus.preferences,
        domains: nextDomains
      });
      setState((current) => current ? { ...current, focus: next } : current);
      setError(undefined);
      return true;
    } catch (caught) {
      setError(readableError(caught));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add(): Promise<void> {
    const parsed = parseFocusDomain(draft);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    if (domains.includes(parsed.domain)) {
      setError(`${parsed.domain} is already on the list`);
      return;
    }
    if (domains.length >= FOCUS_LIMITS.domains) {
      setError(`You can list up to ${FOCUS_LIMITS.domains} sites`);
      return;
    }
    if (await save([...domains, parsed.domain])) setDraft("");
  }

  return (
    <div className="card focus-sites">
      <div className="focus-card-heading">
        <div>
          <strong>Sites that pull you away</strong>
          <span>Subdomains count too: listing youtube.com also covers m.youtube.com.</span>
        </div>
        <small>{domains.length} listed</small>
      </div>
      {domains.length ? (
        <ul className="focus-site-list" aria-label="Distracting sites">
          {domains.map((domain) => (
            <li key={domain}>
              <span>{domain}</span>
              <button
                aria-label={`Remove ${domain}`}
                disabled={saving}
                onClick={() => void save(domains.filter((candidate) => candidate !== domain))}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="focus-quiet">No sites yet. Add the ones that most often pull you off course.</p>
      )}
      <form
        className="focus-site-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          aria-label="Add a distracting site"
          autoCapitalize="off"
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            setError(undefined);
          }}
          placeholder="youtube.com"
          spellCheck={false}
          value={draft}
        />
        <button className="secondary-button" disabled={saving || !draft.trim()} type="submit">Add site</button>
      </form>
      {error ? <InlineError>{error}</InlineError> : null}
      {sessionActive ? <p className="focus-quiet">Site changes apply immediately to this session.</p> : null}
    </div>
  );
}

function DetectionCard({
  focus,
  onOpenSettings,
  setState,
  state
}: {
  focus: FocusViewState;
  onOpenSettings: () => void;
  setState: SetAppState;
  state: BootstrapState;
}): React.JSX.Element {
  const copy = DETECTION_COPY[focus.detection];
  const [error, setError] = useState<string>();
  const ready = focus.detection === "ready";
  const now = useNow(focus.session.status === "active");
  const cooldownSeconds = focus.lastReminderAt
    ? Math.max(0, Math.ceil((Date.parse(focus.lastReminderAt) + FOCUS_TIMING.globalCooldownMs - now) / 1_000))
    : 0;
  const foregroundCopy = useMemo(() => FOREGROUND_COPY[focus.foreground], [focus.foreground]);

  async function run(action: () => Promise<BootstrapState>): Promise<void> {
    setError(undefined);
    try {
      setState(await action());
    } catch (caught) {
      setError(readableError(caught));
    }
  }

  const enableBrowserURLs = (): Promise<BootstrapState> => window.openHistory.updateCollectionSettings({
    ...state.settings,
    captureBrowserURLs: true
  } satisfies CollectionSettings);

  return (
    <div className="card focus-detection">
      <div className="focus-card-heading">
        <div>
          <div className="status-line">
            <span className={`status-light ${ready ? "running" : focus.detection === "capture_paused" ? "" : "failed"}`} />
            {copy.label}
          </div>
          <span>{copy.detail}</span>
        </div>
        {focus.detection === "capture_paused" ? (
          <button className="secondary-button" onClick={() => void run(() => window.openHistory.setCollectionEnabled(true))} type="button">
            Resume capture
          </button>
        ) : focus.detection === "needs_accessibility" ? (
          <button className="secondary-button" onClick={() => void run(() => window.openHistory.requestAccessibilityPermission())} type="button">
            Grant access
          </button>
        ) : focus.detection === "url_capture_off" ? (
          <button className="secondary-button" onClick={() => void run(enableBrowserURLs)} type="button">
            Turn on browser URLs
          </button>
        ) : focus.detection === "collector_unavailable" ? (
          <button className="secondary-button" onClick={onOpenSettings} type="button">Open Settings</button>
        ) : null}
      </div>
      {focus.session.status === "active" ? (
        <p className="focus-foreground" aria-live="polite">{foregroundCopy}</p>
      ) : null}
      {error ? <InlineError>{error}</InlineError> : null}
      <dl className="focus-support">
        <div><dt>Initial browser targets</dt><dd>Safari, Google Chrome</dd></div>
        <div><dt>Experimental</dt><dd>Chrome Beta/Canary, Edge, Brave, Arc, Firefox, Chromium, Vivaldi, Opera</dd></div>
        <div><dt>Excluded when detected</dt><dd>Private and incognito windows, password managers, protected pages, and excluded apps. Private-window detection depends on browser accessibility information.</dd></div>
      </dl>
      {focus.lastReminderAt ? (
        <p className="focus-quiet">Last reminder at {formatClock(focus.lastReminderAt)}.
          {focus.session.status === "active" && cooldownSeconds > 0
            ? ` Next nudge eligible in ${cooldownSeconds}s, if a listed site is in front.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}
