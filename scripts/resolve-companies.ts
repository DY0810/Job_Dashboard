// Phase 3 (workie/p3-registry) — resolves company names to confirmed ATS job-board tokens
// and writes scripts/companies.json + scripts/registry-report.md.
//
// NEVER GUESS A TOKEN INTO THE REGISTRY. Every entry this script writes was confirmed by
// an actual HTTP 200 with a parseable, correctly-shaped jobs/postings body (see
// ats-probe.js for the per-ATS confirmation rule). A company that doesn't confirm goes in
// the unresolved report, never into companies.json with an invented token.
//
// Usage:
//   node scripts/resolve-companies.ts                 full run (all seed sets + YC fetch)
//   node scripts/resolve-companies.ts --skip-yc        skip the YC directory fetch/pull
//   node scripts/resolve-companies.ts --limit=5        only the first N seeds per group (smoke test)
//   node scripts/resolve-companies.ts --dry-run        resolve and log, write nothing
//   node scripts/resolve-companies.ts --groups=voice-ai            only run these seed groups
//   node scripts/resolve-companies.ts --groups=design --skip-yc   only the US design employers
//   node scripts/resolve-companies.ts --extra-ats=teamtailor,pinpoint   also try these ATS types
//   node scripts/resolve-companies.ts --no-report      write companies.json, skip the report

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { resolveCompany } from "./ats-probe.js";
import Database from "better-sqlite3";

interface RegistryEntry {
  name: string;
  ats: string;
  token: string;
  wdN?: string;
  site?: string;
  tags: string[];
  verified_at: string;
  postings_at_probe?: number;
}

interface Seed {
  name: string;
  website?: string;
  tags: string[];
  tryWorkday?: boolean;
}

interface ProbeAttempt {
  ats: string;
  token: string;
  wdN?: string;
  site?: string;
  url: string;
  status: number;
  count: number;
  confirmed: boolean;
  error: string | null;
}

interface ResolveResult {
  confirmed: ProbeAttempt | null;
  attempts: ProbeAttempt[];
}

interface ResolutionOutcome {
  name: string;
  group: string;
  tags: string[];
  status: "resolved" | "dead" | "unresolved";
  entry?: RegistryEntry;
  reason?: string;
  attemptCount: number;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(SCRIPT_DIR, "companies.json");
const REPORT_PATH = join(SCRIPT_DIR, "registry-report.md");
const YC_DIRECTORY_URL = "https://yc-oss.github.io/api/companies/all.json";
const YC_CAP = 150;

// ---------------------------------------------------------------------------------------
// Seed set 1 — Voice AI (plans/workie.md Phase 5, section 5a). All 42, in prompt order.
// `website` is a best-effort hint only, used to derive one extra candidate token — a wrong
// guess here costs nothing, it just fails to help; only a confirmed HTTP response ever
// reaches the registry.
// ---------------------------------------------------------------------------------------
const VOICE_AI_SEEDS: Seed[] = [
  { name: "Vapi", website: "vapi.ai", tags: ["voice-ai"] },
  { name: "Retell", website: "retellai.com", tags: ["voice-ai"] },
  { name: "Bland", website: "bland.ai", tags: ["voice-ai"] },
  { name: "LiveKit", website: "livekit.io", tags: ["voice-ai"] },
  { name: "Daily", website: "daily.co", tags: ["voice-ai"] },
  { name: "Deepgram", website: "deepgram.com", tags: ["voice-ai"] },
  { name: "Cartesia", website: "cartesia.ai", tags: ["voice-ai"] },
  { name: "ElevenLabs", website: "elevenlabs.io", tags: ["voice-ai"] },
  { name: "AssemblyAI", website: "assemblyai.com", tags: ["voice-ai"] },
  { name: "Rime", website: "rime.ai", tags: ["voice-ai"] },
  { name: "Speechmatics", website: "speechmatics.com", tags: ["voice-ai"] },
  { name: "Hume", website: "hume.ai", tags: ["voice-ai"] },
  { name: "Krisp", website: "krisp.ai", tags: ["voice-ai"] },
  { name: "Sesame", website: "sesame.com", tags: ["voice-ai"] },
  { name: "Telnyx", website: "telnyx.com", tags: ["voice-ai"] },
  { name: "Twilio", website: "twilio.com", tags: ["voice-ai"], tryWorkday: true },
  { name: "PolyAI", website: "poly.ai", tags: ["voice-ai"] },
  { name: "Cresta", website: "cresta.com", tags: ["voice-ai"] },
  { name: "Sierra", website: "sierra.ai", tags: ["voice-ai"] },
  { name: "Decagon", website: "decagon.ai", tags: ["voice-ai"] },
  { name: "Parloa", website: "parloa.com", tags: ["voice-ai"] },
  { name: "Observe.AI", website: "observe.ai", tags: ["voice-ai"] },
  { name: "Replicant", website: "replicant.com", tags: ["voice-ai"] },
  { name: "Regal", website: "regal.ai", tags: ["voice-ai"] },
  { name: "Synthflow", website: "synthflow.ai", tags: ["voice-ai"] },
  { name: "Kustomer", website: "kustomer.com", tags: ["voice-ai"] },
  { name: "Assort Health", website: "assorthealth.com", tags: ["voice-ai"] },
  { name: "Infinitus", website: "infinitus.ai", tags: ["voice-ai"] },
  { name: "Hello Patient", website: "hellopatient.com", tags: ["voice-ai"] },
  { name: "Arini", website: "arini.ai", tags: ["voice-ai"] },
  { name: "ConverseNow", website: "conversenow.ai", tags: ["voice-ai"] },
  { name: "Slang.ai", website: "slang.ai", tags: ["voice-ai"] },
  { name: "Numa", website: "numa.com", tags: ["voice-ai"] },
  { name: "Toma", website: "toma.com", tags: ["voice-ai"] },
  { name: "Impel", website: "impel.ai", tags: ["voice-ai"] },
  { name: "Avoca", website: "avoca.ai", tags: ["voice-ai"] },
  { name: "HappyRobot", website: "happyrobot.ai", tags: ["voice-ai"] },
  { name: "Fleetworks", website: "fleetworks.ai", tags: ["voice-ai"] },
  { name: "Vooma", website: "vooma.com", tags: ["voice-ai"] },
  { name: "Liberate", website: "liberate.ai", tags: ["voice-ai"] },
  { name: "Salient", website: "trysalient.com", tags: ["voice-ai"] },
  { name: "Alex", website: "alex.ai", tags: ["voice-ai"] },
];

// Populated from live research (WebSearch, sources in the PR description) before the real
// run. A name here is excluded from probing entirely and never enters the registry, even
// if a stale board would otherwise still confirm — an acquired/dead company isn't an
// independent operator regardless of what its old ATS endpoint still answers.
//
// Research finding: none of the 42 voice-AI seeds are currently dead or acquired. Kustomer
// was acquired by Meta (2020, closed 2022) but was divested back to independent VC
// ownership in May 2023 — independent again, resolved normally below, noted in
// VOICE_AI_NOTES for transparency rather than hidden.
//
// Map, not a plain object: seed names can come from untrusted remote input (the YC
// directory pull below). A company literally named "constructor" or "toString" hits the
// Object.prototype chain on a plain-object lookup — silently "found" as dead/ambiguous,
// with a function as its reason. Map has no prototype chain to collide with.
export const DEAD_OR_ACQUIRED: Map<string, string> = new Map();

// "Alex" could not be confidently tied to one company (see VOICE_AI_NOTES / report) — it is
// excluded from probing for the same reason a dead company is: guessing which "Alex" is
// meant and binding the registry to the wrong one is worse than an honest unresolved entry.
export const AMBIGUOUS_IDENTITY: Map<string, string> = new Map([
  [
    "Alex",
    'ambiguous token — no single voice-AI company clearly named "Alex" could be confidently identified. ' +
      "Candidates found: an AI interview/recruiting voice startup (Peak XV-backed, unrelated to healthcare/CS), " +
      '"ALEX AI Answering Service" (alexoncall.com, generic call answering), and "Alex" used as a product/agent ' +
      "name inside other unrelated companies (Alivo, Alta HQ, curiousthing.io). Probing a generic \"alex\" token " +
      "risks silently binding this registry entry to the wrong company, so it was not attempted. Needs a more " +
      "specific identifier (funding round, founder, one-liner) from whoever sourced the seed list.",
  ],
]);

// Notable ownership history surfaced during verification. Included even though current
// status is "independent" — a reviewer checking whether the acquisition-prone names were
// actually looked at should see the answer, not silence. Keyed by our own hardcoded seed
// names only (never an untrusted remote key), so a plain object is fine here.
const VOICE_AI_NOTES: Record<string, string> = {
  Kustomer:
    "Acquired by Meta in 2020 (deal closed 2022); Meta divested it back to independent VC ownership " +
    "(Battery, Redpoint, Boldstart) in May 2023. Independent again as of this run.",
  "Observe.AI":
    'Not to be confused with the unrelated company "Observe Inc" (observeinc.com, IT observability), ' +
    "which Snowflake agreed to acquire in Jan 2026 — a different company; Observe.AI is unaffected.",
  PolyAI: "Confirmed domain is poly.ai — polyai.com is a different, unrelated site.",
};

// ---------------------------------------------------------------------------------------
// Modest best-effort seed: AI startups, which the plan notes skew Ashby/Greenhouse.
// No dead/acquired accounting is required for this bucket (only the voice-ai 42 has that
// gate) — a miss here is just "unresolved," same as any other candidate that doesn't confirm.
// ---------------------------------------------------------------------------------------
const AI_STARTUP_SEEDS: Seed[] = [
  { name: "Anthropic", website: "anthropic.com", tags: ["ai"] },
  { name: "OpenAI", website: "openai.com", tags: ["ai"] },
  { name: "Perplexity", website: "perplexity.ai", tags: ["ai"] },
  { name: "Mistral AI", website: "mistral.ai", tags: ["ai"] },
  { name: "Together AI", website: "together.ai", tags: ["ai"] },
  { name: "Modal", website: "modal.com", tags: ["ai"] },
  { name: "Replicate", website: "replicate.com", tags: ["ai"] },
  { name: "Runway", website: "runwayml.com", tags: ["ai"] },
  { name: "Pinecone", website: "pinecone.io", tags: ["ai"] },
  { name: "Scale AI", website: "scale.com", tags: ["ai"] },
  { name: "Hugging Face", website: "huggingface.co", tags: ["ai"] },
  { name: "Cohere", website: "cohere.com", tags: ["ai"] },
  { name: "Glean", website: "glean.com", tags: ["ai"] },
  { name: "Harvey", website: "harvey.ai", tags: ["ai"] },
  { name: "Baseten", website: "baseten.co", tags: ["ai"] },
  { name: "LangChain", website: "langchain.com", tags: ["ai"] },
  { name: "Weights & Biases", website: "wandb.ai", tags: ["ai"] },
  { name: "Fireworks AI", website: "fireworks.ai", tags: ["ai"] },
];

// ---------------------------------------------------------------------------------------
// Modest best-effort seed: design and game studios, which the plan notes skew
// Workable/Teamtailor/Workday. Teamtailor is now probeable (see ats-probe.js) but not yet
// promoted into the default sweep — none of these seeds is known to use it going in.
// ---------------------------------------------------------------------------------------
const STUDIO_SEEDS: Seed[] = [
  { name: "IDEO", website: "ideo.com", tags: ["design-studio"] },
  { name: "Pentagram", website: "pentagram.com", tags: ["design-studio"] },
  { name: "MetaLab", website: "metalab.com", tags: ["design-studio"] },
  { name: "Fantasy", website: "fantasy.co", tags: ["design-studio"] },
  { name: "Ustwo", website: "ustwo.com", tags: ["design-studio", "game-studio"] },
  { name: "Frog", website: "frogdesign.com", tags: ["design-studio"] },
  { name: "Supercell", website: "supercell.com", tags: ["game-studio"] },
  { name: "Riot Games", website: "riotgames.com", tags: ["game-studio"], tryWorkday: true },
  { name: "Double Fine", website: "doublefine.com", tags: ["game-studio"] },
  { name: "Klei", website: "klei.com", tags: ["game-studio"] },
];

// ---------------------------------------------------------------------------------------
// Design employers, US. The Design tab was thin for a structural reason rather than a
// connector one: the registry held 74 companies, of which 71 were voice-AI and AI startups
// and 3 were design studios, so the ATS tier — the only tier that reaches employers' own
// boards, and the only one that carries non-remote US roles — had almost no design work to
// find. New feeds cannot fix that; they are mostly remote-worldwide. More design employers can.
//
// Two kinds, and both earn their place:
//   `design-studio`  agencies and studios, where nearly every opening is a design opening.
//   `design-led`     product companies with large in-house design orgs — a smaller share of
//                    design roles each, but far more roles, and they are US-metro based.
//
// A name here is a CANDIDATE, not an entry. `resolveCompany` probes each against every known
// ATS and records only a confirmed 200 with a correctly-shaped body; the rest land in the
// unresolved report. Nothing in this list is assumed to have a board.
// ---------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------
// Companies seen on a LinkedIn internship search that the registry did not hold. Worth noting
// what this list is NOT: it is not scraped from LinkedIn. The names were read off the screen by
// a human and are probed here against each company's own board, which is the difference between
// using LinkedIn as a directory and using it as a source.
// ---------------------------------------------------------------------------------------
const INTERNSHIP_SEEDS: Seed[] = [
  { name: "Palantir Technologies", website: "palantir.com", tags: ["ai"] },
  { name: "L3Harris Technologies", website: "l3harris.com", tags: ["hardware"], tryWorkday: true },
  { name: "Sandhills Global", website: "sandhills.com", tags: ["enterprise"] },
  { name: "Hunter Engineering", website: "hunter.com", tags: ["hardware"] },
  { name: "Foundation Finance", website: "foundationfinance.com", tags: ["fintech"] },
  { name: "Garda Capital Partners", website: "gardacap.com", tags: ["fintech"] },
  { name: "Verition", website: "verition.com", tags: ["fintech"] },
  { name: "Jobright", website: "jobright.ai", tags: ["ai"] },
  { name: "Sixtyfour", website: "sixtyfour.ai", tags: ["ai"] },
  { name: "Genia", website: "genia.com", tags: ["ai"] },
  { name: "Trendline", website: "trendline.ai", tags: ["ai"] },
  { name: "Fooji", website: "fooji.com", tags: ["ai"] },
  { name: "MeeBoss", website: "meeboss.com", tags: ["ai"] },
  { name: "FetchJobs", website: "fetchjobs.co", tags: ["ai"] },
];

// ---------------------------------------------------------------------------------------
// Workday tenants. Large employers overwhelmingly run Workday, and until now the registry had
// none — which is why the Workday connector sat deferred with nothing to iterate. `tryWorkday`
// makes the resolver attempt the Workday shapes after the cheaper ATS families, so a company
// that turns out to be on Greenhouse still resolves there first.
// ---------------------------------------------------------------------------------------
/**
 * Aggregators that answer their JSON API happily and then serve their job PAGES behind a bot
 * check. himalayas.app and jobicy.com both return 403 with a Cloudflare challenge to any server
 * fetch, and a reader clicking "apply" gets the verification screen instead of an application
 * form.
 *
 * What makes it unfixable at the link level: neither API carries the employer's own URL.
 * `applicationLink`, `guid`, and every single link inside the description body point back at the
 * aggregator — checked across a live page of each. So the only way to give one of these postings
 * a working apply button is to find the company's real job board.
 */
const GATED_HOSTS = ["himalayas.app", "jobicy.com"] as const;

/**
 * The companies currently reachable ONLY through one of those pages, read from the corpus rather
 * than typed out here: the set changes with every ingest, and "which employers are stuck behind
 * a bot check" is a question the database can already answer.
 *
 * Resolving one of them fixes the row the reader is already looking at, not just future ones —
 * the same job arrives from greenhouse/lever/ashby on the next ingest, `dedupePostings` merges it
 * into the existing posting, and `canonical_url` prefers an ATS over an aggregator. The apply
 * button changes under the row without the listing moving.
 *
 * Returns nothing when there is no local corpus, so a checkout without `workie.db` still runs
 * every other group.
 */
function gatedAggregatorSeeds(): Seed[] {
  const dbPath = join(dirname(fileURLToPath(import.meta.url)), "..", "workie.db");
  if (!existsSync(dbPath)) return [];
  const clauses = GATED_HOSTS.map((host) => `canonical_url like '%${host}%'`).join(" or ");
  const rows = new Database(dbPath, { readonly: true })
    .prepare(
      `select distinct company from postings where delisted_at is null and (${clauses}) order by company`,
    )
    .all() as { company: string }[];
  return rows
    .map((row) => row.company.trim())
    .filter(Boolean)
    .map((name) => ({ name, tags: ["gated-aggregator"] }));
}

const WORKDAY_SEEDS: Seed[] = [
  { name: "NVIDIA", website: "nvidia.com", tags: ["hardware"], tryWorkday: true },
  { name: "Adobe", website: "adobe.com", tags: ["design-led"], tryWorkday: true },
  { name: "Salesforce", website: "salesforce.com", tags: ["enterprise"], tryWorkday: true },
  { name: "Intuit", website: "intuit.com", tags: ["design-led"], tryWorkday: true },
  { name: "Workday", website: "workday.com", tags: ["enterprise"], tryWorkday: true },
  { name: "Netflix", website: "netflix.com", tags: ["design-led"], tryWorkday: true },
  { name: "Sony", website: "sony.com", tags: ["hardware"], tryWorkday: true },
  { name: "Qualcomm", website: "qualcomm.com", tags: ["hardware"], tryWorkday: true },
  { name: "Cisco", website: "cisco.com", tags: ["enterprise"], tryWorkday: true },
  { name: "Dell", website: "dell.com", tags: ["hardware"], tryWorkday: true },
];

const DESIGN_SEEDS: Seed[] = [
  // Studios and agencies
  { name: "Instrument", website: "instrument.com", tags: ["design-studio"] },
  // From the 2026-08-20 source survey: a small motion/brand studio on Ashby whose board is
  // 7 design roles out of 14 — a higher design density than any product company here.
  { name: "Nen Creative", website: "nen.co", tags: ["design-studio"] },
  { name: "Work & Co", website: "work.co", tags: ["design-studio"] },
  { name: "Huge", website: "hugeinc.com", tags: ["design-studio"] },
  { name: "Code and Theory", website: "codeandtheory.com", tags: ["design-studio"] },
  { name: "Big Human", website: "bighuman.com", tags: ["design-studio"] },
  { name: "Barrel", website: "barrelny.com", tags: ["design-studio"] },
  { name: "Ramotion", website: "ramotion.com", tags: ["design-studio"] },
  { name: "Focus Lab", website: "focuslab.agency", tags: ["design-studio"] },
  { name: "Clay", website: "clay.global", tags: ["design-studio"] },
  { name: "Athletics", website: "athleticsnyc.com", tags: ["design-studio"] },
  { name: "Collins", website: "wearecollins.com", tags: ["design-studio"] },
  { name: "Moving Brands", website: "movingbrands.com", tags: ["design-studio"] },
  { name: "Thoughtbot", website: "thoughtbot.com", tags: ["design-studio"] },
  { name: "Superside", website: "superside.com", tags: ["design-studio"] },
  { name: "Design Pickle", website: "designpickle.com", tags: ["design-studio"] },
  { name: "Dept", website: "deptagency.com", tags: ["design-studio"] },

  // Design-led product companies
  { name: "Figma", website: "figma.com", tags: ["design-led"] },
  { name: "Webflow", website: "webflow.com", tags: ["design-led"] },
  { name: "Framer", website: "framer.com", tags: ["design-led"] },
  { name: "Notion", website: "notion.so", tags: ["design-led"] },
  { name: "Linear", website: "linear.app", tags: ["design-led"] },
  { name: "Vercel", website: "vercel.com", tags: ["design-led"] },
  { name: "Miro", website: "miro.com", tags: ["design-led"] },
  { name: "Airtable", website: "airtable.com", tags: ["design-led"] },
  { name: "Asana", website: "asana.com", tags: ["design-led"] },
  { name: "Dropbox", website: "dropbox.com", tags: ["design-led"] },
  { name: "Squarespace", website: "squarespace.com", tags: ["design-led"] },
  { name: "Duolingo", website: "duolingo.com", tags: ["design-led"] },
  { name: "Discord", website: "discord.com", tags: ["design-led"] },
  { name: "Robinhood", website: "robinhood.com", tags: ["design-led"] },
  { name: "Pinterest", website: "pinterest.com", tags: ["design-led"] },
  { name: "Intercom", website: "intercom.com", tags: ["design-led"] },
  { name: "Retool", website: "retool.com", tags: ["design-led"] },
  { name: "Ramp", website: "ramp.com", tags: ["design-led"] },
  { name: "Brex", website: "brex.com", tags: ["design-led"] },
  { name: "Plaid", website: "plaid.com", tags: ["design-led"] },
  { name: "Rippling", website: "rippling.com", tags: ["design-led"] },
  { name: "Gusto", website: "gusto.com", tags: ["design-led"] },
  { name: "Zapier", website: "zapier.com", tags: ["design-led"] },
  { name: "Grammarly", website: "grammarly.com", tags: ["design-led"] },
  { name: "Patreon", website: "patreon.com", tags: ["design-led"] },
];

// ---------------------------------------------------------------------------------------
// Design employers, wave 2. Its own group so it can be re-probed without re-running the
// first wave, and because the first wave taught two things worth acting on:
//
//   - Product companies resolve far better than studios. Of 42 wave-1 seeds, the twelve that
//     failed were mostly small agencies (Big Human, Barrel, Ramotion, Focus Lab, Moving
//     Brands, Design Pickle) — studios that size tend to run BambooHR, Notion pages or a
//     mailto, none of which is an ATS we can probe. So this wave is 25 product companies to
//     5 agencies, not the even split wave 1 tried.
//   - Design-led beats design-adjacent. A company with an in-house design org posts several
//     design roles a quarter; an agency posts one a year.
//
// NOTHING HERE HAS BEEN TRIED BEFORE. Already failed and deliberately absent: Work & Co, Big
// Human, Barrel, Ramotion, Focus Lab, Moving Brands, Thoughtbot, Design Pickle, Framer,
// Retool, Rippling, Grammarly, Adobe, Salesforce, Intuit, Netflix, Sony, Qualcomm, Cisco,
// Dell, Pentagram, Ustwo, Frog, Double Fine, Klei. Re-seeding a known failure spends ~24
// probes to learn nothing.
// ---------------------------------------------------------------------------------------
const DESIGN_WAVE2_SEEDS: Seed[] = [
  // Consumer and marketplace products, where design is the product surface
  { name: "Stripe", website: "stripe.com", tags: ["design-led"] },
  { name: "Airbnb", website: "airbnb.com", tags: ["design-led"] },
  { name: "Reddit", website: "reddit.com", tags: ["design-led"] },
  { name: "Coinbase", website: "coinbase.com", tags: ["design-led"] },
  { name: "DoorDash", website: "doordash.com", tags: ["design-led"] },
  { name: "Instacart", website: "instacart.com", tags: ["design-led"] },
  { name: "Etsy", website: "etsy.com", tags: ["design-led"] },
  { name: "Roblox", website: "roblox.com", tags: ["design-led"] },
  { name: "Unity", website: "unity.com", tags: ["design-led"] },
  { name: "Calendly", website: "calendly.com", tags: ["design-led"] },

  // Fintech, which hires brand and product design heavily
  { name: "Affirm", website: "affirm.com", tags: ["design-led"] },
  { name: "Chime", website: "chime.com", tags: ["design-led"] },
  { name: "Carta", website: "carta.com", tags: ["design-led"] },
  { name: "Deel", website: "deel.com", tags: ["design-led"] },
  { name: "Klaviyo", website: "klaviyo.com", tags: ["design-led"] },

  // Developer tools with unusually strong design cultures — the wave-1 hits (Linear, Vercel,
  // Figma) all came from this shape of company
  { name: "Vanta", website: "vanta.com", tags: ["design-led"] },
  { name: "Sentry", website: "sentry.io", tags: ["design-led"] },
  { name: "Netlify", website: "netlify.com", tags: ["design-led"] },
  { name: "Supabase", website: "supabase.com", tags: ["design-led"] },
  { name: "Replit", website: "replit.com", tags: ["design-led"] },
  { name: "Raycast", website: "raycast.com", tags: ["design-led"] },
  { name: "The Browser Company", website: "thebrowser.company", tags: ["design-led"] },
  { name: "Superhuman", website: "superhuman.com", tags: ["design-led"] },
  { name: "Front", website: "front.com", tags: ["design-led"] },
  { name: "Descript", website: "descript.com", tags: ["design-led"] },

  // The five agencies large enough to plausibly run a real ATS, which is what separates them
  // from the wave-1 studio failures
  { name: "R/GA", website: "rga.com", tags: ["design-studio"] },
  { name: "AKQA", website: "akqa.com", tags: ["design-studio"] },
  { name: "Wieden+Kennedy", website: "wk.com", tags: ["design-studio"] },
  { name: "Droga5", website: "droga5.com", tags: ["design-studio"] },
  { name: "Koto", website: "koto.studio", tags: ["design-studio"] },
];

interface YcSelection {
  seeds: Seed[];
  totalDirectory: number;
  poolAfterFilter: number;
  selected: number;
  skipped: number;
}

/**
 * Pull the public YC company directory (yc-oss.github.io — a static mirror of the same
 * Algolia index that powers ycombinator.com/companies) and select ~150 of the most
 * active/recent companies. "Work at a Startup" (workatastartup.com) was evaluated too but
 * its listings require an authenticated session (unauthenticated GET on /companies 302s to
 * sign-in) — logging in is out of bounds for this script, so it isn't queried; the
 * directory's own `isHiring` flag is used as the activity signal instead.
 *
 * Selection: status === "Active" (excludes Acquired/Public/Inactive/Dead) and
 * nonprofit === false, ranked isHiring desc then launch date desc (most recent batch
 * first), capped at `cap`. Never a silent truncation — the counts at every funnel step are
 * returned for the report.
 */
async function fetchYcSeeds(cap: number): Promise<YcSelection> {
  try {
    const res = await fetch(YC_DIRECTORY_URL, {
      headers: { "User-Agent": "WorkieRegistryBot/0.1 (+mailto:dongyeop0810@gmail.com)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Array<{
      name?: string;
      website?: string;
      status?: string;
      nonprofit?: boolean;
      isHiring?: boolean;
      launched_at?: number;
    }>;

    const pool = data.filter((c) => c && c.name && c.status === "Active" && c.nonprofit === false);
    const ranked = [...pool].sort((a, b) => {
      const hiringDiff = Number(!!b.isHiring) - Number(!!a.isHiring);
      if (hiringDiff !== 0) return hiringDiff;
      return (b.launched_at ?? 0) - (a.launched_at ?? 0);
    });
    const chosen = ranked.slice(0, cap);
    const seeds: Seed[] = chosen.map((c) => ({
      name: c.name as string,
      website: c.website || undefined,
      tags: ["yc"],
    }));

    return {
      seeds,
      totalDirectory: data.length,
      poolAfterFilter: pool.length,
      selected: chosen.length,
      skipped: pool.length - chosen.length,
    };
  } catch (err) {
    console.error("resolve-companies: YC directory fetch failed, continuing with zero YC seeds:", err);
    return { seeds: [], totalDirectory: 0, poolAfterFilter: 0, selected: 0, skipped: 0 };
  }
}

/**
 * Resolve one seed group concurrently. The per-host throttle inside ats-probe.js is the
 * only concurrency control needed — every company's resolution is an independent async
 * chain, and requests to the same ATS host naturally queue there regardless of how many
 * companies are "in flight" at once, so there's nothing extra to build here.
 */
async function resolveGroup(
  group: string,
  seeds: Seed[],
  existing: Map<string, RegistryEntry>,
  extraAts: string[] = [],
): Promise<ResolutionOutcome[]> {
  const tasks = seeds.map(async (seed): Promise<ResolutionOutcome> => {
    const key = seed.name.toLowerCase();

    const dead = DEAD_OR_ACQUIRED.get(seed.name);
    if (dead) {
      return { name: seed.name, group, tags: seed.tags, status: "dead", reason: dead, attemptCount: 0 };
    }

    const ambiguous = AMBIGUOUS_IDENTITY.get(seed.name);
    if (ambiguous) {
      return { name: seed.name, group, tags: seed.tags, status: "unresolved", reason: ambiguous, attemptCount: 0 };
    }

    const already = existing.get(key);
    if (already) {
      already.tags = Array.from(new Set([...(already.tags ?? []), ...seed.tags]));
      return { name: seed.name, group, tags: already.tags, status: "resolved", entry: already, attemptCount: 0 };
    }

    const { confirmed, attempts } = (await resolveCompany(seed.name, seed.website, {
      tryWorkday: !!seed.tryWorkday,
      extraAts,
    })) as ResolveResult;

    if (confirmed) {
      const entry: RegistryEntry = {
        name: seed.name,
        ats: confirmed.ats,
        token: confirmed.token,
        ...(confirmed.wdN ? { wdN: confirmed.wdN } : {}),
        ...(confirmed.site ? { site: confirmed.site } : {}),
        tags: seed.tags,
        verified_at: new Date().toISOString(),
        postings_at_probe: confirmed.count,
      };
      return { name: seed.name, group, tags: seed.tags, status: "resolved", entry, attemptCount: attempts.length };
    }

    const triedAts = [...new Set(attempts.map((a) => a.ats))];
    const triedTokens = [...new Set(attempts.map((a) => a.token))].slice(0, 6);
    const reason = seed.tryWorkday
      ? `no board found (tried ${attempts.length} probes across ${triedAts.join(", ")}; tokens: ${triedTokens.join(", ")}; Workday tenant undiscoverable)`
      : `no board found (tried ${attempts.length} probes across ${triedAts.join(", ")}; tokens: ${triedTokens.join(", ")}; Workday not attempted — implausible ATS for this company's size)`;

    return { name: seed.name, group, tags: seed.tags, status: "unresolved", reason, attemptCount: attempts.length };
  });

  const settled = await Promise.allSettled(tasks);
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          name: seeds[i].name,
          group,
          tags: seeds[i].tags,
          status: "unresolved" as const,
          reason: `resolver threw unexpectedly: ${String(r.reason)}`,
          attemptCount: 0,
        },
  );
}

function byAtsCounts(registry: RegistryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of registry) counts[e.ats] = (counts[e.ats] ?? 0) + 1;
  return counts;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

// Pulls one `## {title}` section (heading through the line before the next `## `, or EOF)
// out of a previously-generated report. Used so a targeted run (e.g. `--groups=voice-ai`)
// can update just the section(s) it actually touched and leave the others exactly as they
// were, instead of "regenerating" them from zero outcomes and silently blanking them out.
function extractOldSection(oldMarkdown: string | null, title: string): string | null {
  if (!oldMarkdown) return null;
  const heading = `## ${title}`;
  const start = oldMarkdown.indexOf(heading);
  if (start === -1) return null;
  const rest = oldMarkdown.slice(start);
  const nextRel = rest.slice(heading.length).search(/\n## /);
  const end = nextRel === -1 ? rest.length : heading.length + nextRel + 1;
  return rest.slice(0, end).trimEnd() + "\n";
}

function listOutcomes(outcomes: ResolutionOutcome[], notes?: Record<string, string>): string {
  if (outcomes.length === 0) return "_none_";
  return outcomes
    .map((o) => {
      const note = notes?.[o.name];
      if (o.status === "resolved" && o.entry) {
        const loc = o.entry.ats === "workday" ? `${o.entry.token} / ${o.entry.wdN} / ${o.entry.site}` : o.entry.token;
        const countNote = o.entry.postings_at_probe === 0 ? " (0 open postings at probe time — board confirmed, currently empty)" : "";
        const base = `- **${o.name}** — \`${o.entry.ats}\`:\`${loc}\`${countNote}`;
        return note ? `${base}\n  - _${note}_` : base;
      }
      const base = `- **${o.name}** — ${o.reason ?? "no reason recorded"}`;
      return note ? `${base}\n  - _${note}_` : base;
    })
    .join("\n");
}

function writeReport(outcomes: ResolutionOutcome[], ycMeta: YcSelection | null, registry: RegistryEntry[]): void {
  const oldReport = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf8") : null;

  const byGroup = (g: string) => outcomes.filter((o) => o.group === g);
  const voiceAi = byGroup("voice-ai");
  const voiceResolved = voiceAi.filter((o) => o.status === "resolved");
  const voiceUnresolved = voiceAi.filter((o) => o.status === "unresolved");
  const voiceDead = voiceAi.filter((o) => o.status === "dead");

  const aiStartups = byGroup("ai-startups");
  const studios = byGroup("studios");
  const yc = byGroup("yc");

  const atsCounts = byAtsCounts(registry);
  const atsTable = Object.entries(atsCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([ats, n]) => `| ${ats} | ${n} |`)
    .join("\n");

  const totalSeeded = outcomes.length;
  const totalResolvedThisRun = outcomes.filter((o) => o.status === "resolved").length;
  const totalUnresolved = outcomes.filter((o) => o.status === "unresolved").length;
  const totalDead = outcomes.filter((o) => o.status === "dead").length;

  const parts: string[] = [];
  parts.push(`# Company Registry Report\n\nGenerated ${new Date().toISOString()} by \`scripts/resolve-companies.ts\`.\n`);

  parts.push(
    section(
      "Registry — resolved count by ATS",
      `\`scripts/companies.json\` holds **${registry.length}** entries total (across every phase this script has been run for).\n\n| ATS | Count |\n| --- | --- |\n${atsTable}\n`,
    ),
  );

  parts.push(
    section(
      "Run summary",
      [
        `- Companies considered this run: **${totalSeeded}**`,
        `- Newly resolved: **${totalResolvedThisRun}**`,
        `- Unresolved: **${totalUnresolved}**`,
        `- Dead / acquired: **${totalDead}**`,
      ].join("\n"),
    ),
  );

  // Voice-AI ran as a full group even on a targeted re-probe (the 31 already-resolved +
  // Alex all short-circuit without a network call), so `voiceAi` is always the complete 42
  // when this section is touched at all — no old-section fallback needed for it.
  if (voiceAi.length > 0) {
    parts.push(
      section(
        "Voice-AI seed accounting (Phase 5a — plans/workie.md §5a, 42 companies)",
        [
          `- Resolved into registry: **${voiceResolved.length}**`,
          `- Unresolved: **${voiceUnresolved.length}**`,
          `- Dead / acquired: **${voiceDead.length}**`,
          ``,
          `**${voiceResolved.length} + ${voiceUnresolved.length} + ${voiceDead.length} = ${voiceResolved.length + voiceUnresolved.length + voiceDead.length}** (seed list length: 42)`,
          ``,
          `### Resolved\n\n${listOutcomes(voiceResolved, VOICE_AI_NOTES)}`,
          ``,
          `### Unresolved (with reason)\n\n${listOutcomes(voiceUnresolved, VOICE_AI_NOTES)}`,
          ``,
          `### Dead or acquired (with what was found)\n\n${listOutcomes(voiceDead, VOICE_AI_NOTES)}`,
        ].join("\n"),
      ),
    );
  } else {
    const preserved = extractOldSection(oldReport, "Voice-AI seed accounting (Phase 5a — plans/workie.md §5a, 42 companies)");
    if (preserved) parts.push(preserved);
  }

  if (ycMeta) {
    parts.push(
      section(
        "YC seed set",
        [
          `**Selection criterion:** pulled \`${YC_DIRECTORY_URL}\` (a static mirror of the same Algolia index behind ycombinator.com/companies — used in place of Work at a Startup, whose /companies listing 302-redirects to a login page for unauthenticated requests and was not scraped). Filtered to \`status === "Active"\` and \`nonprofit === false\`, ranked by \`isHiring\` desc then launch date desc (most recent batch first), capped at ${YC_CAP}.`,
          ``,
          `- Total companies in YC directory: **${ycMeta.totalDirectory}**`,
          `- After status/nonprofit filter (the plausible pool): **${ycMeta.poolAfterFilter}**`,
          `- Selected (most active/recent, capped): **${ycMeta.selected}**`,
          `- Skipped (in the plausible pool but past the cap): **${ycMeta.skipped}**`,
          ``,
          `Of the ${ycMeta.selected} selected: **${yc.filter((o) => o.status === "resolved").length}** resolved, **${yc.filter((o) => o.status === "unresolved").length}** unresolved.`,
          ``,
          `### Resolved\n\n${listOutcomes(yc.filter((o) => o.status === "resolved"))}`,
          ``,
          `### Unresolved (with reason)\n\n${listOutcomes(yc.filter((o) => o.status === "unresolved"))}`,
        ].join("\n"),
      ),
    );
  } else {
    const preserved = extractOldSection(oldReport, "YC seed set");
    if (preserved) parts.push(preserved);
  }

  if (aiStartups.length > 0) {
    parts.push(
      section(
        "AI-startup seed set (modest, best-effort)",
        [
          `Of ${aiStartups.length} candidates: **${aiStartups.filter((o) => o.status === "resolved").length}** resolved, **${aiStartups.filter((o) => o.status === "unresolved").length}** unresolved.`,
          ``,
          `### Resolved\n\n${listOutcomes(aiStartups.filter((o) => o.status === "resolved"))}`,
          ``,
          `### Unresolved (with reason)\n\n${listOutcomes(aiStartups.filter((o) => o.status === "unresolved"))}`,
        ].join("\n"),
      ),
    );
  } else {
    const preserved = extractOldSection(oldReport, "AI-startup seed set (modest, best-effort)");
    if (preserved) parts.push(preserved);
  }

  if (studios.length > 0) {
    parts.push(
      section(
        "Design/game studio seed set (modest, best-effort)",
        [
          `Of ${studios.length} candidates: **${studios.filter((o) => o.status === "resolved").length}** resolved, **${studios.filter((o) => o.status === "unresolved").length}** unresolved. Teamtailor is now probeable but a studio that only publishes through it and hasn't been re-checked yet still shows here as unresolved, not a bug.`,
          ``,
          `### Resolved\n\n${listOutcomes(studios.filter((o) => o.status === "resolved"))}`,
          ``,
          `### Unresolved (with reason)\n\n${listOutcomes(studios.filter((o) => o.status === "unresolved"))}`,
        ].join("\n"),
      ),
    );
  } else {
    const preserved = extractOldSection(oldReport, "Design/game studio seed set (modest, best-effort)");
    if (preserved) parts.push(preserved);
  }

  // Methodology always regenerates fresh from the current code, never falls back to an
  // old version — unlike the group sections above, it describes the rules as they exist
  // right now, and freezing it would mean a real rule change (like this one) could never
  // actually reach the report.
  parts.push(
    section(
      "Methodology",
        [
          "- A candidate (ats, token) pair counts as **confirmed** per a per-ATS rule (see `scripts/ats-probe.js`): greenhouse/lever/ashby/recruitee/teamtailor/pinpoint 404 an unknown token, so any HTTP 200 with the right shape confirms the token even at zero current postings; workable/smartrecruiters/workday return 200 + an empty shell for tokens that don't exist at all, so those three still require a non-empty array.",
          "- Candidate tokens: lowercase-no-punctuation slug, hyphenated slug, both with common suffixes (inc/llc/co/corp/ltd/ai) stripped, and the domain stem of any known website — deduped, capped at 6 per company.",
          "- Rate limit: max 2 requests/second per host, enforced by a shared per-host throttle in `scripts/ats-probe.js`; different ATS hosts run concurrently.",
          "- Workday discovery (tenant × wd1/wd3/wd5/wd103 × site-name guesses) is opt-in per company and was only attempted where there's an actual reason to expect a large/established employer (Twilio, Riot Games) — running it blindly against every small startup in the seed sets would multiply request volume for near-zero plausible yield, since Workday targets enterprise HR, not 20-person startups. Everyone else's \"no board found\" reason notes Workday was not attempted, not that it was tried and failed.",
          "- Teamtailor and Pinpoint are confirmed-probeable (verified against real tenants: recruitgo.teamtailor.com, workwithus.pinpointhq.com) but not in the default sweep — plans/workie.md's rule is \"add them when the registry actually has a company on one, not before.\" Rippling and BambooHR remain unconfirmed: Rippling's documented Job Board API is gated behind a paid subscription and its public page renders job data client-side with no stable JSON surface found; BambooHR's only public surface is, per multiple independent sources, an undocumented internal endpoint that changes shape/host between releases, and no real customer example could be found to verify against. Both are skipped rather than guessed, same standard as everything else in this phase.",
        "- Every registry write carries `verified_at` set to the moment of that successful probe, and `postings_at_probe` recording the exact count seen (0 is valid and meaningful — it means a real, confirmed board with no current openings, not \"not found\").",
      ].join("\n"),
    ),
  );

  writeFileSync(REPORT_PATH, parts.join("\n"));
}

/** Strict CLI-arg validation — a typo must fail loudly, never silently degrade into "0 companies". */
export function parseLimit(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A run that resolved nothing has nothing new to say — leave the existing registry file alone. */
export function shouldWriteRegistry(resolvedCount: number): boolean {
  return resolvedCount > 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipYc = args.includes("--skip-yc");
  const noReport = args.includes("--no-report");

  const limitArg = args.find((a) => a.startsWith("--limit="));
  let limit: number | undefined;
  if (limitArg) {
    const raw = limitArg.split("=")[1];
    const parsed = parseLimit(raw);
    if (parsed === null) {
      console.error(
        `resolve-companies: invalid --limit value "${raw}" — must be a positive integer. Aborting before touching anything.`,
      );
      process.exitCode = 1;
      return;
    }
    limit = parsed;
  }

  const groupsArg = args.find((a) => a.startsWith("--groups="));
  const onlyGroups = groupsArg
    ? new Set(
        groupsArg
          .split("=")[1]
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      )
    : null;

  const extraAtsArg = args.find((a) => a.startsWith("--extra-ats="));
  const extraAts = extraAtsArg
    ? extraAtsArg
        .split("=")[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const existingRegistry: RegistryEntry[] = existsSync(REGISTRY_PATH)
    ? (JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as RegistryEntry[])
    : [];
  const existingMap = new Map(existingRegistry.map((e) => [e.name.toLowerCase(), e]));
  console.log(`resolve-companies: starting with ${existingRegistry.length} existing registry entries`);
  if (extraAts.length > 0) console.log(`resolve-companies: also trying extra ATS types: ${extraAts.join(", ")}`);

  let ycMeta: YcSelection | null = null;
  const groups: { label: string; seeds: Seed[] }[] = [
    { label: "voice-ai", seeds: VOICE_AI_SEEDS },
    { label: "ai-startups", seeds: AI_STARTUP_SEEDS },
    { label: "studios", seeds: STUDIO_SEEDS },
    { label: "design", seeds: DESIGN_SEEDS },
    { label: "design-wave2", seeds: DESIGN_WAVE2_SEEDS },
    { label: "workday", seeds: WORKDAY_SEEDS },
    { label: "internships", seeds: INTERNSHIP_SEEDS },
  ];
  // Computed only when it will be used — it opens the local corpus, which a bare checkout has no
  // reason to require for a `--groups=design` run.
  if (!onlyGroups || onlyGroups.has("gated")) {
    const gated = gatedAggregatorSeeds();
    if (gated.length > 0) groups.push({ label: "gated", seeds: gated });
    console.log(`resolve-companies: ${gated.length} companies reachable only behind a bot check`);
  }
  const wantsYc = !skipYc && (!onlyGroups || onlyGroups.has("yc"));
  if (wantsYc) {
    ycMeta = await fetchYcSeeds(YC_CAP);
    groups.push({ label: "yc", seeds: ycMeta.seeds });
    console.log(
      `resolve-companies: YC directory ${ycMeta.totalDirectory} total, ${ycMeta.poolAfterFilter} active pool, selected ${ycMeta.selected}, skipped ${ycMeta.skipped}`,
    );
  }

  const allOutcomes: ResolutionOutcome[] = [];
  for (const group of groups) {
    if (onlyGroups && !onlyGroups.has(group.label)) continue;
    const seeds = typeof limit === "number" ? group.seeds.slice(0, limit) : group.seeds;
    console.log(`resolve-companies: resolving ${seeds.length} companies in group "${group.label}"...`);
    const outcomes = await resolveGroup(group.label, seeds, existingMap, extraAts);
    for (const o of outcomes) {
      if (o.status === "resolved" && o.entry) existingMap.set(o.name.toLowerCase(), o.entry);
    }
    allOutcomes.push(...outcomes);
    const resolvedCount = outcomes.filter((o) => o.status === "resolved").length;
    console.log(`resolve-companies: group "${group.label}" done — ${resolvedCount}/${seeds.length} resolved`);
  }

  // Belt-and-suspenders: a dead/acquired or ambiguous-identity company never rides into the
  // registry, even from an earlier run's already-confirmed entry.
  for (const excludedName of [...DEAD_OR_ACQUIRED.keys(), ...AMBIGUOUS_IDENTITY.keys()]) {
    existingMap.delete(excludedName.toLowerCase());
  }

  const finalRegistry = [...existingMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totalResolvedThisRun = allOutcomes.filter((o) => o.status === "resolved").length;

  if (dryRun) {
    console.log("resolve-companies: --dry-run set, not writing companies.json or the report");
  } else if (!shouldWriteRegistry(totalResolvedThisRun)) {
    console.log(
      `resolve-companies: 0 companies resolved this run — leaving ${REGISTRY_PATH} untouched. ` +
        "A run that resolves nothing has nothing new to say and must not overwrite good data with a no-op " +
        "(this is also what a bad --limit/--groups/--only value degrades to safely, instead of wiping the file).",
    );
  } else {
    writeFileSync(REGISTRY_PATH, JSON.stringify(finalRegistry, null, 2) + "\n");
    console.log(`resolve-companies: wrote ${finalRegistry.length} entries to ${REGISTRY_PATH}`);
    if (noReport) {
      console.log("resolve-companies: --no-report set, leaving registry-report.md untouched");
    } else {
      writeReport(allOutcomes, ycMeta, finalRegistry);
      console.log(`resolve-companies: wrote report to ${REPORT_PATH}`);
    }
  }

  console.log("resolve-companies: registry counts by ATS:", byAtsCounts(finalRegistry));
}

// Only run when executed directly (`node resolve-companies.ts`), not when imported — e.g.
// by a test file pulling in parseLimit/DEAD_OR_ACQUIRED/etc. Importing this module must
// never trigger a live network run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("resolve-companies: unexpected fatal error:", err);
    process.exitCode = 1;
  });
}
