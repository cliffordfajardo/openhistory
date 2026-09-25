import { FOCUS_LIMITS, type FocusViewState, type Goal, type GoalDraft } from "@shared/focus";
import { useState } from "react";
import { InlineError, focusAction, type SetAppState } from "./shared";

type Editing = { mode: "new" } | { mode: "edit"; goal: Goal } | undefined;

export function GoalsPage({
  focus,
  onStartFocus,
  setState
}: {
  focus: FocusViewState;
  onStartFocus: () => void;
  setState: SetAppState;
}): React.JSX.Element {
  const [editing, setEditing] = useState<Editing>(focus.goals.length === 0 ? { mode: "new" } : undefined);
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [error, setError] = useState<string>();
  const activeGoalId = focus.session.status === "active" ? focus.session.goal.id : undefined;

  async function select(goal: Goal): Promise<void> {
    setError(await focusAction(setState, () => window.openHistory.selectGoal(goal.id)));
  }

  async function remove(goal: Goal): Promise<void> {
    const failure = await focusAction(setState, () => window.openHistory.deleteGoal(goal.id));
    setError(failure);
    if (!failure) setPendingDelete(undefined);
  }

  return (
    <section className="page-stack goals-page" aria-labelledby="goals-title">
      <div className="goals-heading">
        <div>
          <span className="eyebrow focus-eyebrow">Goals</span>
          <h2 id="goals-title">What you’re working toward</h2>
          <p>Each reminder shows the selected goal and your intention, so it points back to something you chose.</p>
        </div>
        {editing?.mode !== "new" ? (
          <button className="primary-button" onClick={() => setEditing({ mode: "new" })} type="button">New goal</button>
        ) : null}
      </div>

      {editing?.mode === "new" ? (
        <GoalEditor
          onCancel={focus.goals.length ? () => setEditing(undefined) : undefined}
          onSaved={() => setEditing(undefined)}
          setState={setState}
        />
      ) : null}

      {error ? <InlineError>{error}</InlineError> : null}

      {focus.goals.length === 0 && editing?.mode !== "new" ? (
        <div className="empty-state">
          <h2>No goals yet</h2>
          <p>Create a goal to anchor your focus sessions.</p>
        </div>
      ) : (
        <ul className="goal-list" aria-label="Goals">
          {focus.goals.map((goal) => {
            const selected = goal.id === focus.selectedGoalId;
            if (editing?.mode === "edit" && editing.goal.id === goal.id) {
              return (
                <li key={goal.id}>
                  <GoalEditor
                    goal={goal}
                    onCancel={() => setEditing(undefined)}
                    onSaved={() => setEditing(undefined)}
                    setState={setState}
                  />
                </li>
              );
            }
            return (
              <li className={`card goal-card${selected ? " is-selected" : ""}`} key={goal.id}>
                <div className="goal-card-heading">
                  <strong>{goal.title}</strong>
                  {goal.id === activeGoalId ? (
                    <span className="goal-badge is-active">In session</span>
                  ) : selected ? (
                    <span className="goal-badge">Selected</span>
                  ) : null}
                </div>
                {goal.why ? (
                  <div className="goal-detail"><span>Why it matters</span><p>{goal.why}</p></div>
                ) : null}
                {goal.currentFocus ? (
                  <div className="goal-detail"><span>Current focus</span><p>{goal.currentFocus}</p></div>
                ) : null}
                <div className="goal-actions">
                  {selected ? (
                    <button className="secondary-button" onClick={onStartFocus} type="button">Go to Focus</button>
                  ) : (
                    <button className="secondary-button" onClick={() => void select(goal)} type="button">Use for focus</button>
                  )}
                  <button className="secondary-button" onClick={() => setEditing({ mode: "edit", goal })} type="button">Edit</button>
                  {pendingDelete === goal.id ? (
                    <span className="goal-delete-confirm" role="group" aria-label={`Confirm deleting ${goal.title}`}>
                      <button className="danger-button" onClick={() => void remove(goal)} type="button">Delete goal</button>
                      <button className="secondary-button" onClick={() => setPendingDelete(undefined)} type="button">Keep</button>
                    </span>
                  ) : (
                    <button
                      aria-label={`Delete ${goal.title}`}
                      className="danger-button"
                      onClick={() => setPendingDelete(goal.id)}
                      type="button"
                    >
                      Delete…
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {focus.goals.length >= FOCUS_LIMITS.goals ? (
        <p className="focus-quiet">You’ve reached the limit of {FOCUS_LIMITS.goals} goals.</p>
      ) : null}
    </section>
  );
}

function GoalEditor({
  goal,
  onCancel,
  onSaved,
  setState
}: {
  goal?: Goal;
  onCancel?: () => void;
  onSaved: () => void;
  setState: SetAppState;
}): React.JSX.Element {
  const [title, setTitle] = useState(goal?.title ?? "");
  const [why, setWhy] = useState(goal?.why ?? "");
  const [currentFocus, setCurrentFocus] = useState(goal?.currentFocus ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const idPrefix = goal ? `goal-${goal.id}` : "goal-new";

  async function save(): Promise<void> {
    if (!title.trim()) {
      setError("Give the goal a title");
      return;
    }
    setSaving(true);
    const draft: GoalDraft = { ...(goal ? { id: goal.id } : {}), title, why, currentFocus };
    const failure = await focusAction(setState, () => window.openHistory.saveGoal(draft));
    setSaving(false);
    setError(failure);
    if (!failure) onSaved();
  }

  return (
    <form
      aria-label={goal ? `Edit ${goal.title}` : "New goal"}
      className="card goal-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="focus-field">
        <label htmlFor={`${idPrefix}-title`}>Title</label>
        <input
          autoFocus
          id={`${idPrefix}-title`}
          maxLength={FOCUS_LIMITS.goalTitle}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Ship the onboarding redesign"
          required
          value={title}
        />
      </div>
      <div className="focus-field">
        <label htmlFor={`${idPrefix}-why`}>Why it matters</label>
        <textarea
          id={`${idPrefix}-why`}
          maxLength={FOCUS_LIMITS.goalWhy}
          onChange={(event) => setWhy(event.target.value)}
          placeholder="New people get stuck in the first five minutes."
          rows={3}
          value={why}
        />
      </div>
      <div className="focus-field">
        <label htmlFor={`${idPrefix}-focus`}>Current focus</label>
        <textarea
          id={`${idPrefix}-focus`}
          maxLength={FOCUS_LIMITS.goalCurrentFocus}
          onChange={(event) => setCurrentFocus(event.target.value)}
          placeholder="Finish the welcome screen copy"
          rows={2}
          value={currentFocus}
        />
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="goal-actions">
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "Saving…" : goal ? "Save changes" : "Create goal"}
        </button>
        {onCancel ? (
          <button className="secondary-button" disabled={saving} onClick={onCancel} type="button">Cancel</button>
        ) : null}
      </div>
    </form>
  );
}
