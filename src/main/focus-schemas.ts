import {
  FOCUS_BAR_PRESENTATIONS,
  FOCUS_BAR_WIDTH,
  FOCUS_EXPERIENCES,
  FOCUS_LIMITS,
  FOCUS_PROGRESS_COLOR_DEFAULT,
  parseFocusDomain,
  type FocusBarPosition,
  type FocusBarPresentation,
  type FocusExperience,
  type FocusPreferences,
  type FocusSessionEdit,
  type FocusStartRequest,
  type GoalDraft,
  type PersistedFocusSession
} from "@shared/focus";
import { z } from "zod";


const singleLine = (maximum: number) => z.string()
  .max(maximum * 4)
  .transform((value) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim())
  .pipe(z.string().max(maximum));

const multiLine = (maximum: number) => z.string()
  .max(maximum * 4)
  .transform((value) => value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim())
  .pipe(z.string().max(maximum));

export const GOAL_ID_PATTERN = /^goal-[a-z0-9-]{8,64}$/;
export const GoalIdSchema = z.string().regex(GOAL_ID_PATTERN);

const GoalTitleSchema = singleLine(FOCUS_LIMITS.goalTitle)
  .refine((value) => value.length > 0, { message: "Give the goal a title" });

export const GoalSchema = z.object({
  id: GoalIdSchema,
  title: GoalTitleSchema,
  why: multiLine(FOCUS_LIMITS.goalWhy),
  currentFocus: multiLine(FOCUS_LIMITS.goalCurrentFocus)
}).strict();

export const GoalDraftSchema: z.ZodType<GoalDraft> = z.object({
  id: GoalIdSchema.optional(),
  title: GoalTitleSchema,
  why: multiLine(FOCUS_LIMITS.goalWhy),
  currentFocus: multiLine(FOCUS_LIMITS.goalCurrentFocus)
}).strict();

export const DurationMinutesSchema = z.number()
  .int()
  .min(FOCUS_LIMITS.minimumDurationMinutes)
  .max(FOCUS_LIMITS.maximumDurationMinutes);

const DomainRuleSchema = z.string().max(2_048).transform((value, context) => {
  const parsed = parseFocusDomain(value);
  if (!parsed.ok) {
    context.addIssue({ code: "custom", message: parsed.reason });
    return z.NEVER;
  }
  return parsed.domain;
});

export const FocusExperienceSchema: z.ZodType<FocusExperience> = z.enum(FOCUS_EXPERIENCES);

export const FocusBarPresentationSchema: z.ZodType<FocusBarPresentation> = z.enum(FOCUS_BAR_PRESENTATIONS);

/**
 * A saved bar position. Screens can sit far from the origin, so the range is generous; a position
 * that no longer lands on a connected display is clamped when the bar is shown, not rejected here.
 */
const BarCoordinateSchema = z.number().finite().min(-200_000).max(200_000)
  .transform((value) => Math.round(value));

export const FocusBarPositionSchema: z.ZodType<FocusBarPosition> = z.object({
  x: BarCoordinateSchema,
  y: BarCoordinateSchema
}).strict();

/**
 * The shared progress color. Exactly six ASCII hex digits behind a `#`: no shorthand, no alpha, no
 * color names and no other notation, so every surface can read the same value without guessing.
 * The canonical form is lowercase, which is also what a native color well produces.
 */
export const FocusProgressColorSchema = z.string()
  .max(7)
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase());

export const FocusBarWidthSchema = z.number().finite()
  .min(FOCUS_BAR_WIDTH.minimum)
  .max(FOCUS_BAR_WIDTH.maximum)
  .transform((value) => Math.round(value));

/** Renderer or bar edit of the running session. Every field is optional and applied on its own. */
export const FocusSessionEditSchema: z.ZodType<FocusSessionEdit> = z.object({
  goalId: GoalIdSchema.optional(),
  intention: multiLine(FOCUS_LIMITS.intention).optional(),
  remainingMinutes: z.number().int()
    .min(FOCUS_LIMITS.minimumRemainingMinutes)
    .max(FOCUS_LIMITS.maximumDurationMinutes)
    .optional()
}).strict().refine(
  (value) => value.goalId !== undefined || value.intention !== undefined || value.remainingMinutes !== undefined,
  { message: "Change the goal, the intention or the remaining minutes" }
);

const DomainListSchema = z.array(DomainRuleSchema)
  .max(FOCUS_LIMITS.domains)
  .transform((domains) => [...new Set(domains)].sort());

/**
 * Stored preferences. Files written before reminder styles existed have no `experience`; they
 * keep every goal and site and read as the original amber reminder. Files written before the edge
 * was separate from grayscale have no `amberEdge`: it stays on only for those that used the amber
 * style, so grayscale choices keep looking the same.
 */
export const FocusPreferencesSchema: z.ZodType<FocusPreferences> = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || "amberEdge" in value) return value;
  const experience = (value as { experience?: unknown }).experience;
  return { ...value, amberEdge: experience === undefined || experience === "amber" };
}, z.object({
  domains: DomainListSchema,
  durationMinutes: DurationMinutesSchema,
  experience: FocusExperienceSchema.default("amber"),
  amberEdge: z.boolean(),
  /** Files written before the floating bar existed get it, matching a fresh install. */
  barPresentation: FocusBarPresentationSchema.default("floating"),
  /** Off for files written before the timer bar existed and for fresh installs alike. */
  showTimerBar: z.boolean().default(false),
  /** Files written before the color could be chosen keep the green both bars already drew. */
  progressColor: FocusProgressColorSchema.default(FOCUS_PROGRESS_COLOR_DEFAULT)
}).strict());

/** Renderer input. An omitted `experience` keeps the saved one instead of resetting it. */
export const FocusPreferencesInputSchema = z.object({
  domains: DomainListSchema,
  durationMinutes: DurationMinutesSchema,
  experience: FocusExperienceSchema.optional()
}).strict();

export const FocusStartRequestSchema: z.ZodType<FocusStartRequest> = z.object({
  goalId: GoalIdSchema,
  intention: multiLine(FOCUS_LIMITS.intention),
  durationMinutes: DurationMinutesSchema
}).strict();

const IsoInstantSchema = z.string().max(40).refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "Not a valid time" }
);

/**
 * The saved session. It is validated strictly and on its own: exactly one clock, a whole goal
 * copied at the time it started, and a total the remainder fits inside. Anything else is discarded
 * rather than repaired, because a half-understood session would start the wrong countdown.
 */
export const PersistedFocusSessionSchema: z.ZodType<PersistedFocusSession> = z.object({
  id: z.string().min(1).max(100),
  goal: GoalSchema,
  intention: multiLine(FOCUS_LIMITS.intention),
  startedAt: IsoInstantSchema,
  endsAt: IsoInstantSchema.nullable(),
  totalMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pausedRemainingMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  snoozedUntil: IsoInstantSchema.nullable()
}).strict().refine(
  (session) => (session.endsAt === null) !== (session.pausedRemainingMs === null),
  { message: "A saved session has a deadline or a frozen remainder, never both" }
).refine(
  (session) => session.pausedRemainingMs === null || session.pausedRemainingMs <= session.totalMs,
  { message: "A saved session cannot have more time left than it was ever given" }
);

export const FocusDocumentSchema = z.object({
  version: z.literal(1),
  goals: z.array(GoalSchema).max(FOCUS_LIMITS.goals),
  selectedGoalId: GoalIdSchema.nullable(),
  preferences: FocusPreferencesSchema,
  barPosition: FocusBarPositionSchema.nullable().default(null),
  barWidth: FocusBarWidthSchema.default(FOCUS_BAR_WIDTH.default),
  /**
   * A malformed session is dropped here instead of failing the whole file: goals, sites and
   * preferences are worth keeping even when the session that was running is not understood.
   */
  session: PersistedFocusSessionSchema.nullable().catch(null).default(null)
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  for (const goal of document.goals) {
    if (ids.has(goal.id)) context.addIssue({ code: "custom", message: "Duplicate goal identifier" });
    ids.add(goal.id);
  }
});

export type FocusDocument = z.infer<typeof FocusDocumentSchema>;

export function firstIssueMessage(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  return issue?.code === "custom" && issue.message ? issue.message : fallback;
}
