import { z } from "zod";
import { ProviderError, ProviderStateSchema, type TypesafeResult } from "./providers.ts";

const actionId = z.string().trim().regex(/^[a-z][a-z0-9:_-]{0,63}$/);
const actionLabel = z.string().trim().min(1).max(300);
const observedAction = z.strictObject({ id: actionId, label: actionLabel });
export const JEV_ACTION_MIN_CONFIDENCE = 0.75;

export const JevActionSelectionSchema = z.strictObject({
  state: ProviderStateSchema,
  actions: z.array(observedAction).min(1).max(16),
}).superRefine((value, context) => {
  const ids = value.actions.map((action) => action.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["actions"], message: "Duplicate action IDs." });
  if (ids.length !== value.state.observedActions.length || ids.some((id) => !value.state.observedActions.includes(id))) {
    context.addIssue({ code: "custom", path: ["state", "observedActions"], message: "State actions must match the observed action list." });
  }
});
export type JevActionSelection = z.infer<typeof JevActionSelectionSchema>;
export type JevActionDecision = {
  actionId: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  usage: TypesafeResult["usage"];
};
export type JevDecisionProvider = {
  evaluate(state: unknown, questions: unknown, signal?: AbortSignal): Promise<TypesafeResult>;
};
export type JevActionSelector = (
  input: JevActionSelection,
  options?: { signal?: AbortSignal; isCurrent?: (actionIds: readonly string[]) => boolean; minConfidence?: number },
) => Promise<JevActionDecision>;

/**
 * Jev may rank the current observed controls, but Workie owns the action set and execution.
 * `isCurrent` is checked after the await so a rerender cannot apply a stale decision.
 */
export function createJevActionSelector(provider: JevDecisionProvider): JevActionSelector {
  return async (input, options = {}) => {
    const selection = JevActionSelectionSchema.parse(input);
    const ids = selection.actions.map((action) => action.id);
    if (ids.length === 1) {
      if (options.isCurrent && !options.isCurrent(ids)) throw new ProviderError("PROVIDER_DECISION_STALE");
      return { actionId: ids[0], confidence: 1, probabilities: { [ids[0]]: 1 }, model: "deterministic", usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const criteria = Object.fromEntries(selection.actions.map((action) => [action.id, action.label]));
    const result = await provider.evaluate(selection.state, {
      select_action: {
        type: "choice",
        instructions: "Choose exactly one current observed action to inspect next. Never invent an action or perform it.",
        criteria,
      },
    }, options.signal);
    if (options.isCurrent && !options.isCurrent(ids)) throw new ProviderError("PROVIDER_DECISION_STALE");
    const answer = result.answers.select_action;
    if (!answer || answer.type !== "choice" || !ids.includes(answer.choice)) {
      throw new ProviderError("PROVIDER_INVALID_DECISION");
    }
    const minConfidence = options.minConfidence ?? JEV_ACTION_MIN_CONFIDENCE;
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new ProviderError("PROVIDER_POLICY_INVALID");
    }
    if (answer.confidence < minConfidence) throw new ProviderError("PROVIDER_LOW_CONFIDENCE");
    return {
      actionId: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: result.model,
      usage: result.usage,
    };
  };
}
