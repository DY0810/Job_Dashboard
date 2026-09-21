import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "./providers.ts";
import { createJevActionSelector } from "./jev.ts";

const state = {
  company: "Synthetic Labs",
  role: "Engineer Intern",
  ats: "greenhouse",
  tenant: "synthetic",
  fields: [{ label: "Name", kind: "text" }, { label: "Resume", kind: "document" }],
  observedActions: ["fill_name", "upload_resume"],
};
const actions = [
  { id: "fill_name", label: "Fill the observed name field" },
  { id: "upload_resume", label: "Upload the already-approved resume artifact" },
];
const result = {
  model: "jev-1.13.0",
  answers: {
    select_action: {
      type: "choice",
      choice: "upload_resume",
      probabilities: { fill_name: 0.1, upload_resume: 0.9 },
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 10, output_tokens: 2 },
};

test("Jev selects only a current observed action and receives labels, not values", async () => {
  let request, requestOptions;
  const select = createJevActionSelector({
    evaluate: async (sentState, questions, _signal, options) => {
      request = { sentState, questions };
      requestOptions = options;
      return result;
    },
  });
  const decision = await select({ state, actions }, { runId: "synthetic-run" });
  assert.equal(decision.actionId, "upload_resume");
  assert.deepEqual(request.sentState, state);
  assert.deepEqual(Object.keys(request.questions.select_action.criteria), ["fill_name", "upload_resume"]);
  assert.match(request.questions.select_action.instructions, /Never invent/);
  assert.deepEqual(requestOptions, { runId: "synthetic-run" });
});

test("Jev cannot invent actions or apply a stale observation", async () => {
  const select = createJevActionSelector({
    evaluate: async () => ({ ...result, answers: { select_action: {
      ...result.answers.select_action, choice: "run_shell",
    } } }),
  });
  await assert.rejects(select({ state, actions }), (error) =>
    error instanceof ProviderError && error.code === "PROVIDER_INVALID_DECISION");

  const fresh = createJevActionSelector({ evaluate: async () => result });
  await assert.rejects(fresh({ state, actions }, { isCurrent: () => false }), (error) =>
    error instanceof ProviderError && error.code === "PROVIDER_DECISION_STALE");
});

test("selection input rejects action lists that do not match the observed state", async () => {
  const select = createJevActionSelector({ evaluate: async () => result });
  await assert.rejects(select({ state, actions: [{ id: "run_shell", label: "Untrusted action" }] }), /State actions must match/);
});

test("a single observed action is deterministic and does not spend provider budget", async () => {
  let called = false;
  const select = createJevActionSelector({ evaluate: async () => { called = true; return result; } });
  const decision = await select({ state: { ...state, observedActions: ["fill_name"] }, actions: [actions[0]] });
  assert.deepEqual(decision, { actionId: "fill_name", confidence: 1, probabilities: { fill_name: 1 }, model: "deterministic", usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(called, false);
});

test("low-confidence choices fail closed before a browser action", async () => {
  const select = createJevActionSelector({ evaluate: async () => ({
    ...result, answers: { select_action: { ...result.answers.select_action, confidence: 0.74 } },
  }) });
  await assert.rejects(select({ state, actions }), /PROVIDER_LOW_CONFIDENCE/);
});
