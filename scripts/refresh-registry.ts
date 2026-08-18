// Monthly refresh (plans/worky.md Phase 3 registry maintenance): re-probes every entry in
// scripts/companies.json using its exact recorded (ats, token, wdN?, site?) — no candidate
// guessing, the value is already on record — and either bumps `verified_at` on a fresh 200
// + non-empty payload, or flags the entry when it isn't confirmed anymore.
//
// It NEVER deletes an entry. A flagged entry stays in the registry so a human can look at
// it and decide — a board can be down for an hour, mid-migration, or genuinely gone, and
// this script can't tell those apart from one failed probe.
//
// Usage: node scripts/refresh-registry.ts   (intended to run monthly, e.g. via launchd)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { probeAts } from "./ats-probe.js";

interface RegistryEntry {
  name: string;
  ats: string;
  token: string;
  wdN?: string;
  site?: string;
  tags: string[];
  verified_at: string;
  flagged_at?: string;
  flag_reason?: string;
}

interface ProbeResult {
  confirmed: boolean;
  status: number;
  count: number;
  error: string | null;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(SCRIPT_DIR, "companies.json");

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as RegistryEntry[];
  console.log(`refresh-registry: re-probing ${registry.length} entries (this may take a few minutes)...`);

  let stillGood = 0;
  let recovered = 0;
  let newlyFlagged = 0;
  let stillFlagged = 0;

  const tasks = registry.map(async (entry) => {
    const result = (await probeAts(entry.ats, entry.token, { wdN: entry.wdN, site: entry.site })) as ProbeResult;
    const now = new Date().toISOString();

    if (result.confirmed) {
      entry.verified_at = now;
      if (entry.flagged_at) {
        recovered++;
        delete entry.flagged_at;
        delete entry.flag_reason;
      } else {
        stillGood++;
      }
      return;
    }

    const wasFlagged = !!entry.flagged_at;
    entry.flagged_at = now;
    entry.flag_reason = result.error
      ? `network error: ${result.error}`
      : result.status === 200
        ? "HTTP 200 but 0 postings returned"
        : `HTTP ${result.status}`;
    if (wasFlagged) stillFlagged++;
    else newlyFlagged++;
  });

  const settled = await Promise.allSettled(tasks);
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`refresh-registry: probe threw for ${registry[i].name} (leaving entry untouched):`, r.reason);
    }
  });

  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");

  console.log(
    `refresh-registry: done — ${stillGood} still good, ${recovered} recovered, ${newlyFlagged} newly flagged, ` +
      `${stillFlagged} still flagged. Nothing was deleted; flagged entries need a human look.`,
  );

  const flagged = registry.filter((e) => e.flagged_at);
  if (flagged.length > 0) {
    console.log("refresh-registry: flagged entries:");
    for (const e of flagged) {
      const loc = e.ats === "workday" ? `${e.token}/${e.wdN}/${e.site}` : e.token;
      console.log(`  - ${e.name} (${e.ats}:${loc}) — ${e.flag_reason}`);
    }
  }
}

main().catch((err) => {
  console.error("refresh-registry: unexpected fatal error:", err);
  process.exitCode = 1;
});
