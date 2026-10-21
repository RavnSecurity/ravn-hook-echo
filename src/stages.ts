/**
 * The seven triage stages, and the six a program can send to a hook.
 *
 * Intake cannot be sent to a hook until a tool can send reports in
 * (ravn-product#46), so it has no endpoint here.
 */
export const STAGES = [
  "intake",
  "classify",
  "route",
  "assess",
  "review",
  "follow-up",
  "knowledge",
] as const;
export type Stage = (typeof STAGES)[number];

export const HOOKABLE = [
  "classify",
  "route",
  "assess",
  "review",
  "follow-up",
  "knowledge",
] as const;
export type HookableStage = (typeof HOOKABLE)[number];

export function isHookable(value: string): value is HookableStage {
  return (HOOKABLE as readonly string[]).includes(value);
}

/** The `x-ravn-event` value Ravn sends with a stage's packet. */
export function stageRequestedEvent(stage: HookableStage): string {
  return `stage.${stage}.requested`;
}

/** The stage named by an `x-ravn-event` header, or null when it names none. */
export function stageOfEvent(event: string | undefined): HookableStage | null {
  if (!event) return null;
  const m = /^stage\.([a-z-]+)\.requested$/.exec(event.trim());
  if (!m?.[1]) return null;
  return isHookable(m[1]) ? m[1] : null;
}

/** Where each stage's envelope and output live in the public schema. */
export const ENVELOPE_DEF: Record<HookableStage, string> = {
  classify: "ClassifyEnvelope",
  route: "RouteEnvelope",
  assess: "AssessEnvelope",
  review: "ReviewEnvelope",
  "follow-up": "FollowUpEnvelope",
  knowledge: "KnowledgeEnvelope",
};

export const OUT_DEF: Record<HookableStage, string> = {
  classify: "ClassifyOut",
  route: "RouteOut",
  assess: "AssessOut",
  review: "ReviewOut",
  "follow-up": "FollowUpOut",
  knowledge: "KnowledgeOut",
};
