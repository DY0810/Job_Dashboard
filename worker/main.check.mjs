import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredJevActionSelector } from "./main.ts";
import { privateStore } from "./storage.ts";

const scope = { origin: "https://workie.example", ownerId: "synthetic-owner", workerId: "synthetic-worker" };
const config = {
  providerProtocolVersion: 1, ownerId: scope.ownerId, profileRevision: 2, policyRevision: 3,
  policyVersion: 1, policyHash: null, enabled: true, provider: "typesafe_jev", model: "jev-latest",
  endpoint: null, privacy: "approved_remote", remoteProviderConsent: true,
  allowedProviders: ["typesafe:jev"], fallbackOrder: [], maxUsd: 10,
};

const directory = await mkdtemp(join(tmpdir(), "main-jev-"));
try {
  const providerStore = await privateStore(directory, { ...scope, workerId: `${scope.workerId}:provider` });
  let keyReads = 0;
  const selector = createConfiguredJevActionSelector(scope, config, providerStore, (service, account) => {
    assert.equal(service, "Workie TypeSafe API");
    assert.equal(account, "dongyeop0810@gmail.com");
    keyReads++;
    return { getPassword: () => "synthetic-typesafe-key" };
  }, async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.state.fields[0].label, "Full name");
    assert(!JSON.stringify(request).includes("synthetic-typesafe-key"));
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { select_action: {
        type: "choice", choice: "field_focused", probabilities: { field_focused: 0.8, question_detected: 0.2 }, confidence: 0.8,
      } },
      usage: { input_tokens: 20, output_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert(selector);
  assert.equal(keyReads, 0);
  const result = await selector({
    state: {
      company: "Synthetic Co", role: "Engineer", ats: "fixture", tenant: "synthetic",
      fields: [{ label: "Full name", kind: "text" }], observedActions: ["field_focused", "question_detected"],
    },
    actions: [
      { id: "field_focused", label: "Focus the next field" },
      { id: "question_detected", label: "Inspect a question" },
    ],
  });
  assert.equal(result.actionId, "field_focused");
  assert.equal(keyReads, 1);
} finally {
  await rm(directory, { recursive: true, force: true });
}
