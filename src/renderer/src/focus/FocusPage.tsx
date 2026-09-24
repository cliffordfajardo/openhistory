import type { BootstrapState, CollectionSettings } from "@shared/contracts";
import {
  FOCUS_DURATION_PRESETS,
  FOCUS_LIMITS,
  FOCUS_PROGRESS_COLOR_PRESETS,
  FOCUS_TIMING,
  focusSessionProgress,
  focusSessionRemainingMs,
  parseFocusDomain,
  type FocusDetectionState,
  type FocusEffectFallbackReason,
  type FocusEffectState,
  type FocusExperience,
  type FocusForegroundSummary,
  type FocusViewState
} from "@shared/focus";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  InlineError,
  focusAction,
  formatClock,
  formatRemaining,
  readableError,
  useNow,
  withFocus,
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
  paused: "Paused — the countdown is frozen and nothing is watched until you resume.",
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

const EXPERIENCE_COPY: Record<FocusExperience, { label: string; detail: string }> = {
  amber: {
    label: "None",
    detail: "Colors stay as they are. No extra permission."
  },
  grayscale_window: {
    label: "Window",
    detail: "The distracting window’s area turns gray while the reminder shows. The rest of the display stays in color. Needs Screen Recording."
  },
  grayscale_screen: {
    label: "Screen",
    detail: "The entire display with the distracting window turns gray while the reminder shows. Other displays stay in color. Needs Screen Recording."
  },
  grayscale_system: {
    label: "System",
    detail: "Experimental. Turns on macOS Color Filters through a private setting: every display turns gray, including the card and amber edge. No Screen Recording."
  }
};

const FALLBACK_COPY: Record<FocusEffectFallbackReason, string> = {
  permission_needed: "Screen Recording isn’t allowed",
  unsupported: "this build or Mac can’t capture the screen",
  capture_failed: "screen capture stopped or couldn’t start",
  no_frame: "no screen image arrived in time",
  display_unavailable: "the display changed or couldn’t be found",
  window_unavailable: "the distracting window couldn’t be matched or followed exactly",
  window_spans_displays: "the window is on more than one display",
  system_filter_failed: "Color Filters couldn’t be changed",
  system_filter_unavailable: "system grayscale isn’t available on this Mac",
  system_filter_restored: "you restored colors"
};

function effectStatusCopy(effect: FocusEffectState, amberEdge: boolean): string | undefined {
  const subject = effect.preview ? "preview" : "reminder";
  if (effect.status === "fallback") {
    const reason = FALLBACK_COPY[effect.fallbackReason ?? "capture_failed"];
    const shown = amberEdge ? "the card and amber edge" : "only the card";
    return effect.visible
      ? `Grayscale isn’t on (${reason}), so this ${subject} shows ${shown}.`
      : `The last ${subject} showed without grayscale: ${reason}.`;
  }
  if (!effect.visible || effect.requested === "amber") return undefined;
  if (effect.requested === "grayscale_system") {
    return `macOS reports Color Filters set to grayscale for this ${subject}.`;
  }
  return effect.status === "preparing"
    ? `Starting grayscale for this ${subject}…`
    : `Grayscale is showing for this ${subject}.`;
}

export function FocusPage({
  editRequest,
  onManageGoals,
  onOpenSettings,
  setState,
  state
}: {
  /** Counter raised when the bar or the menu bar asks for the session editor. */
  editRequest: number;
  onManageGoals: () => void;
  onOpenSettings: () => void;
  setState: SetAppState;
  state: BootstrapState;
}): React.JSX.Element {
  const focus = state.focus;
  const [editing, setEditing] = useState(false);
  const active = focus.session.status === "active";

  useEffect(() => {
    if (!active) setEditing(false);
  }, [active]);

  useEffect(() => {
    if (editRequest > 0) setEditing(true);
  }, [editRequest]);

  return (
    <section className="page-stack focus-page" aria-label="Focus">
      {focus.recoveredFromInvalidFile ? (
        <div className="notice" role="status">
          Your saved goals couldn’t be read, so Focus started fresh. The unreadable file was kept beside the new one in your data folder.
        </div>
      ) : null}
      {active
        ? <ActiveSessionCard editing={editing} focus={focus} setEditing={setEditing} setState={setState} />
        : <StartSessionCard focus={focus} onManageGoals={onManageGoals} setState={setState} />}
      <SessionDisplayCard focus={focus} setState={setState} />
      <DistractingSitesCard focus={focus} setState={setState} />
      <ReminderStyleCard focus={focus} setState={setState} />
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
    setPreviewMessage(await previewReminder(setState));
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
        Focus is a gentle nudge, not a blocker. When a listed site is in front, a short reminder appears with your chosen style. Every site stays reachable.
      </p>
    </form>
  );
}

function ActiveSessionCard({
  editing,
  focus,
  setEditing,
  setState
}: {
  editing: boolean;
  focus: FocusViewState;
  setEditing: (editing: boolean) => void;
  setState: SetAppState;
}): React.JSX.Element {
  const session = focus.session.status === "active" ? focus.session : undefined;
  const paused = session?.endsAt === null;
  const now = useNow(Boolean(session) && !paused);
  const [error, setError] = useState<string>();
  const [previewMessage, setPreviewMessage] = useState<string>();
  if (!session) return <></>;
  const remaining = focusSessionRemainingMs(session, now);
  const progress = focusSessionProgress(session, now);
  const snoozedUntil = session.snoozedUntil ? Date.parse(session.snoozedUntil) : undefined;
  const snoozed = snoozedUntil !== undefined && snoozedUntil > now;

  async function run(action: () => Promise<FocusViewState>): Promise<void> {
    setError(await focusAction(setState, action));
  }

  async function preview(): Promise<void> {
    setPreviewMessage(undefined);
    setPreviewMessage(await previewReminder(setState));
  }

  return (
    <div className="card focus-hero is-active">
      <div className="focus-active-heading">
        <span className="eyebrow focus-eyebrow">{paused ? "Paused" : "Focusing"}</span>
        <span className="focus-ends">
          {session.endsAt === null ? "Countdown frozen" : `Ends at ${formatClock(session.endsAt)}`}
        </span>
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
        {paused ? (
          <button className="primary-button" onClick={() => void run(() => window.openHistory.resumeFocusSession())} type="button">
            Resume session
          </button>
        ) : (
          <button className="primary-button" onClick={() => void run(() => window.openHistory.pauseFocusSession())} type="button">
            Pause session
          </button>
        )}
        <button className="secondary-button" onClick={() => void run(() => window.openHistory.stopFocus())} type="button">
          Complete session
        </button>
        <button
          aria-expanded={editing}
          className="secondary-button"
          onClick={() => setEditing(!editing)}
          type="button"
        >
          {editing ? "Close edit" : "Edit session"}
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
      {editing ? <EditSessionForm focus={focus} onDone={() => setEditing(false)} setState={setState} /> : null}
      {previewMessage ? <p className="focus-quiet" role="status">{previewMessage}</p> : null}
      <p className="focus-honest-note">
        Watching {session.domains.length} {session.domains.length === 1 ? "site" : "sites"}. Pausing freezes the countdown and stops reminders; snooze only quiets reminders while the clock keeps running. Sessions resume after restart. Paused time stays frozen; running sessions keep counting down while the app is closed.
      </p>
    </div>
  );
}

function EditSessionForm({
  focus,
  onDone,
  setState
}: {
  focus: FocusViewState;
  onDone: () => void;
  setState: SetAppState;
}): React.JSX.Element {
  const session = focus.session.status === "active" ? focus.session : undefined;
  const remainingMinutes = session
    ? Math.max(FOCUS_LIMITS.minimumRemainingMinutes, Math.round(focusSessionRemainingMs(session, Date.now()) / 60_000))
    : FOCUS_LIMITS.minimumRemainingMinutes;
  const [goalId, setGoalId] = useState(
    focus.session.status === "active" ? focus.session.goal.id : focus.selectedGoalId ?? ""
  );
  const [intention, setIntention] = useState(session?.intention ?? "");
  const [minutes, setMinutes] = useState(String(remainingMinutes));
  const [minutesEdited, setMinutesEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!session) return <></>;

  const minutesValue = Number(minutes);
  const minutesValid = Number.isInteger(minutesValue) &&
    minutesValue >= FOCUS_LIMITS.minimumRemainingMinutes &&
    minutesValue <= FOCUS_LIMITS.maximumDurationMinutes;

  async function save(): Promise<void> {
    if (!session || !minutesValid) return;
    setBusy(true);
    const failure = await focusAction(setState, () => window.openHistory.editFocusSession({
      ...(goalId && goalId !== session.goal.id ? { goalId } : {}),
      intention,
      ...(minutesEdited ? { remainingMinutes: minutesValue } : {})
    }));
    setBusy(false);
    setError(failure);
    if (!failure) onDone();
  }

  return (
    <form
      className="focus-edit-session"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="focus-field">
        <label htmlFor="focus-edit-goal">Goal</label>
        <select id="focus-edit-goal" onChange={(event) => setGoalId(event.target.value)} value={goalId}>
          {focus.goals.some((goal) => goal.id === session.goal.id) ? null : (
            <option value={session.goal.id}>{session.goal.title} (deleted)</option>
          )}
          {focus.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
        </select>
      </div>
      <div className="focus-field">
        <label htmlFor="focus-edit-intention">This session, I’ll…</label>
        <textarea
          id="focus-edit-intention"
          maxLength={FOCUS_LIMITS.intention}
          onChange={(event) => setIntention(event.target.value)}
          rows={2}
          value={intention}
        />
      </div>
      <label className="focus-custom-duration">
        <span>Minutes left</span>
        <input
          aria-label="Minutes left in this session"
          inputMode="numeric"
          max={FOCUS_LIMITS.maximumDurationMinutes}
          min={FOCUS_LIMITS.minimumRemainingMinutes}
          onChange={(event) => { setMinutes(event.target.value); setMinutesEdited(true); }}
          type="number"
          value={minutes}
        />
        {!minutesValid ? (
          <small>Choose {FOCUS_LIMITS.minimumRemainingMinutes}–{FOCUS_LIMITS.maximumDurationMinutes} minutes.</small>
        ) : null}
      </label>
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="focus-actions">
        <button className="primary-button" disabled={busy || !minutesValid} type="submit">Save changes</button>
        <button className="secondary-button" onClick={onDone} type="button">Cancel</button>
      </div>
      <p className="focus-quiet">
        Only change the time if you want a new countdown. Your saved goal stays unchanged.
      </p>
    </form>
  );
}

function ProgressColorRow({
  focus,
  setError,
  setState
}: {
  focus: FocusViewState;
  setError: (message: string | undefined) => void;
  setState: SetAppState;
}): React.JSX.Element {
  const [pending, setPending] = useState<string>();
  const queued = useRef<string | undefined>(undefined);
  const saving = useRef(false);
  const color = pending ?? focus.preferences.progressColor;

  async function choose(value: string): Promise<void> {
    queued.current = value;
    setPending(value);
    if (saving.current) return;
    saving.current = true;
    try {
      while (queued.current !== undefined) {
        const nextColor = queued.current;
        queued.current = undefined;
        try {
          const next = await window.openHistory.setFocusProgressColor(nextColor);
          if (queued.current === undefined) {
            setPending(undefined);
            setError(undefined);
            withFocus(setState, next);
          }
        } catch (caught) {
          if (queued.current === undefined) {
            setPending(undefined);
            setError(readableError(caught));
          }
        }
      }
    } finally {
      saving.current = false;
    }
  }

  return (
    <div className="focus-color">
      <span className="focus-color-title" id="focus-color-label">Color</span>
      <div aria-labelledby="focus-color-label" className="focus-color-choices" role="group">
        {FOCUS_PROGRESS_COLOR_PRESETS.map((preset) => (
          <button
            aria-label={preset.name}
            aria-pressed={color === preset.value}
            className={color === preset.value ? "focus-color-swatch is-chosen" : "focus-color-swatch"}
            key={preset.value}
            onClick={() => void choose(preset.value)}
            style={{ "--swatch": preset.value } as React.CSSProperties}
            title={preset.name}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 8.4 6.8 11 12 5.4" /></svg>
          </button>
        ))}
        <label className="focus-color-custom" title="Custom color">
          <span className="focus-color-well" style={{ "--swatch": color } as React.CSSProperties} />
          <span>Custom</span>
          <input
            aria-label="Custom progress color"
            onChange={(event) => void choose(event.target.value)}
            type="color"
            value={color}
          />
        </label>
      </div>
      <small className="focus-quiet">
        Applies immediately to both progress bars.
      </small>
    </div>
  );
}

function SessionDisplayCard({
  focus,
  setState
}: {
  focus: FocusViewState;
  setState: SetAppState;
}): React.JSX.Element {
  const [error, setError] = useState<string>();
  const presentation = focus.preferences.barPresentation;
  const active = focus.session.status === "active";
  const showTimerBar = focus.preferences.showTimerBar;

  async function run(action: () => Promise<FocusViewState>): Promise<void> {
    setError(await focusAction(setState, action));
  }

  return (
    <div className="card focus-display">
      <div className="focus-card-heading">
        <div>
          <strong>While a session runs</strong>
          <span>The menu-bar icon always shows the countdown and every session control. The floating bar is an optional second place for them.</span>
        </div>
      </div>
      <div className="focus-style-options" role="radiogroup" aria-label="Where to show the running session">
        {([
          ["floating", "Floating bar", "A small bar above the Dock with the goal, countdown, pause and complete. Drag it anywhere, or drag an edge or corner to resize it; its place and size are remembered."],
          ["menuBar", "Menu bar only", "No floating bar. The countdown and controls stay in the menu-bar icon."]
        ] as const).map(([option, label, detail]) => (
          <button
            aria-checked={presentation === option}
            className={presentation === option ? "focus-style-option active" : "focus-style-option"}
            disabled={option === "floating" && !focus.barAvailable}
            key={option}
            onClick={() => void run(() => window.openHistory.setFocusBarPresentation(option))}
            role="radio"
            type="button"
          >
            <strong>{label}</strong>
            <span>{detail}</span>
          </button>
        ))}
      </div>
      {!focus.barAvailable ? (
        <p className="focus-quiet">This build has no native floating bar, so the menu bar carries the session.</p>
      ) : null}
      <label className="focus-edge-toggle">
        <input
          checked={showTimerBar}
          disabled={!focus.timerBarAvailable}
          onChange={(event) => void run(() => window.openHistory.setFocusShowTimerBar(event.target.checked))}
          type="checkbox"
        />
        <span>
          <strong>Show timer bar</strong>
          <small>
            A quiet bar across the top of the screen that shrinks as the time left runs out.
            Every display shows the same one, and clicks pass straight through it.
          </small>
        </span>
      </label>
      {!focus.timerBarAvailable ? (
        <p className="focus-quiet">This build has no native timer bar.</p>
      ) : null}
      <ProgressColorRow focus={focus} setError={setError} setState={setState} />
      {active && presentation === "floating" && focus.barAvailable ? (
        <div className="focus-actions">
          <button className="secondary-button" onClick={() => void run(() => window.openHistory.focusFocusBar())} type="button">
            Focus the bar
          </button>
        </div>
      ) : null}
      <p className="focus-quiet">
        Keyboard: use <strong>Focus the bar</strong> above, or <strong>Focus Floating Bar</strong> in the menu-bar icon, to move focus into the bar. Then Tab between its controls, press Space or Return to use one, and press Escape to hand the keyboard back. Hovering or focusing the bar reveals pause, complete and its overflow menu; drag the bar itself to move it, any edge or corner to resize it, and use <strong>Reset Width</strong> or <strong>Reset Height</strong> in the overflow menu to put either back.
      </p>
      {error ? <InlineError>{error}</InlineError> : null}
    </div>
  );
}

async function previewReminder(setState: SetAppState): Promise<string> {
  let requested: FocusExperience = "amber";
  const failure = await focusAction(setState, async () => {
    const next = await window.openHistory.previewFocusReminder();
    requested = next.effect?.requested ?? "amber";
    return next;
  });
  if (failure) return failure;
  if (requested === "amber") return "Preview shown on this display for about 8 seconds.";
  if (requested === "grayscale_system") {
    return "Preview shown for about 8 seconds; your earlier colors return afterward. Status is under Reminder style.";
  }
  return requested === "grayscale_window"
    ? "Preview shown for about 8 seconds. This window stands in for the distracting one. Grayscale status is under Reminder style."
    : "Preview card shown on this display for about 8 seconds. Grayscale status is under Reminder style.";
}

function ReminderStyleCard({
  focus,
  setState
}: {
  focus: FocusViewState;
  setState: SetAppState;
}): React.JSX.Element {
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const { experience, amberEdge } = focus.preferences;
  const access = focus.screenCapture.access;
  const effectCopy = focus.effect ? effectStatusCopy(focus.effect, amberEdge) : undefined;
  const capture = experience === "grayscale_window" || experience === "grayscale_screen";
  const systemFilter = focus.systemFilter;
  const showSystemStatus = experience === "grayscale_system" || systemFilter.restorePending ||
    systemFilter.phase === "restore_failed";

  async function choose(next: FocusExperience): Promise<void> {
    if (next === experience || saving) return;
    setSaving(true);
    setError(await focusAction(setState, () => window.openHistory.setFocusExperience(next)));
    setSaving(false);
  }

  async function setEdge(next: boolean): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(await focusAction(setState, () => window.openHistory.setFocusAmberEdge(next)));
    setSaving(false);
  }

  async function run(action: () => Promise<FocusViewState>): Promise<void> {
    setError(await focusAction(setState, action));
  }

  async function openSettings(): Promise<void> {
    setError(undefined);
    try {
      await window.openHistory.openScreenCaptureSettings();
    } catch (caught) {
      setError(readableError(caught));
    }
  }

  return (
    <div className="card focus-style">
      <div className="focus-card-heading">
        <div>
          <strong>Reminder style</strong>
          <span>Every reminder shows the same card with Snooze and Dismiss. Changes apply right away, even during a session.</span>
        </div>
      </div>
      <label className="focus-edge-toggle">
        <input
          checked={amberEdge}
          disabled={saving}
          onChange={(event) => void setEdge(event.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>Amber edge</strong>
          <small>A soft amber glow around the display with the distracting window. Works with any grayscale choice.</small>
        </span>
      </label>
      <p className="focus-quiet" id="focus-grayscale-label">Grayscale while a reminder shows</p>
      <div className="focus-style-options" role="radiogroup" aria-labelledby="focus-grayscale-label">
        {(Object.keys(EXPERIENCE_COPY) as FocusExperience[]).map((option) => (
          <button
            aria-checked={experience === option}
            className={experience === option ? "focus-style-option active" : "focus-style-option"}
            disabled={saving || (option === "grayscale_system" && experience !== option && !systemFilter.available)}
            key={option}
            onClick={() => void choose(option)}
            role="radio"
            type="button"
          >
            <strong>{EXPERIENCE_COPY[option].label}</strong>
            <span>{EXPERIENCE_COPY[option].detail}</span>
          </button>
        ))}
      </div>
      {showSystemStatus ? <SystemFilterStatus focus={focus} setState={setState} /> : null}
      {capture ? (
        <div className="focus-style-permission">
          <div className="status-line">
            <span className={`status-light ${access === "granted" ? "running" : "failed"}`} />
            {access === "granted"
              ? "Screen Recording allowed"
              : access === "not_granted"
                ? "Screen Recording not allowed — reminders show without grayscale"
                : "Captured grayscale isn’t available in this build — reminders show without it"}
          </div>
          {access === "not_granted" ? (
            <>
              <p className="focus-quiet">
                {focus.screenCapture.requested
                  ? "Turn on OpenHistory Focus in System Settings → Privacy & Security → Screen & System Audio Recording. macOS may ask you to quit and reopen the app, then choose Check again."
                  : "macOS asks once. If you allow it, macOS may ask you to quit and reopen the app."}
              </p>
              <div className="focus-actions">
                {focus.screenCapture.requested ? (
                  <button className="secondary-button" onClick={() => void openSettings()} type="button">Open Settings</button>
                ) : (
                  <button className="secondary-button" onClick={() => void run(() => window.openHistory.requestScreenCaptureAccess())} type="button">
                    Grant Screen Recording
                  </button>
                )}
                <button className="secondary-button" onClick={() => void run(() => window.openHistory.refreshScreenCaptureAccess())} type="button">
                  Check again
                </button>
              </div>
            </>
          ) : null}
          <p className="focus-quiet">
            Grayscale uses a live screen capture while the reminder is visible. Images stay on your Mac and are never saved or uploaded. The reminder card stays in color, and macOS shows a screen-recording indicator.
          </p>
        </div>
      ) : null}
      {effectCopy ? <p className="focus-foreground" aria-live="polite">{effectCopy}</p> : null}
      {error ? <InlineError>{error}</InlineError> : null}
    </div>
  );
}

const SYSTEM_FILTER_STATUS_COPY: Record<FocusViewState["systemFilter"]["phase"], string> = {
  idle: "Your Color Filters settings are unchanged.",
  applied: "System grayscale is on; your earlier Color Filters settings return when the reminder ends.",
  restore_failed: "Your earlier Color Filters settings couldn’t be restored yet. System grayscale waits until they are.",
  unsupported: "System grayscale isn’t available on this Mac. Reminders show without it."
};

function SystemFilterStatus({
  focus,
  setState
}: {
  focus: FocusViewState;
  setState: SetAppState;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { phase, failure, restorePending } = focus.systemFilter;

  async function restore(): Promise<void> {
    setBusy(true);
    setError(await focusAction(setState, () => window.openHistory.restoreFocusSystemColors()));
    setBusy(false);
  }

  return (
    <div className="focus-style-permission">
      <div className="status-line" aria-live="polite">
        <span className={`status-light ${phase === "restore_failed" || phase === "unsupported" || failure ? "failed" : "running"}`} />
        {SYSTEM_FILTER_STATUS_COPY[phase]}
      </div>
      {failure ? (
        <p className="focus-quiet">
          {failure === "journal_unwritable"
            ? "The last reminder left colors alone because your settings couldn’t be saved for restoring."
            : "The last reminder couldn’t change Color Filters."}
        </p>
      ) : null}
      <p className="focus-quiet">
        Experimental: uses a private macOS setting that may stop working in a future macOS. It affects every display and is
        restored when the reminder ends or the app quits; after a crash, on the next launch.
      </p>
      {error ? <InlineError>{error}</InlineError> : null}
      {restorePending || phase === "applied" ? (
        <div className="focus-actions">
          <button className="secondary-button" disabled={busy} onClick={() => void restore()} type="button">
            Restore previous colors
          </button>
        </div>
      ) : null}
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
        durationMinutes: focus.preferences.durationMinutes,
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
        <div><dt>Excluded when detected</dt><dd>Private and incognito windows, password managers, protected pages, and excluded apps. Private-window detection depends on browser accessibility information. Listed webmail sites can still trigger reminders by site name when email activity is excluded from history.</dd></div>
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
