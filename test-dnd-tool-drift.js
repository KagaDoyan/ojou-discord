// test-dnd-tool-drift.js
// Standalone repro harness for: "as a D&D session progresses, Gemini stops calling the tool
// and instead writes the tool call out as text in its narration." Drives the exact same
// prompt shape as askAyameDnd/runDndLoop in index.js (same persona, same tool declarations,
// same MAX_DND_TOOL_STEPS chain, same compaction thresholds) against a real Gemini call, but
// self-plays both "players" with scripted chaotic multi-action turns designed to force long
// tool-call chains within a single turn — since session.history itself is compacted and stays
// small, the actual risk zone is IN-TURN chain depth (up to 12 steps), not raw session length.
//
// Writes/reads through the real dndMechanics.js JSON stores under a throwaway channel id, and
// deletes that channel's data again in a `finally` block so nothing pollutes real bot data.
//
// Run: bun test-dnd-tool-drift.js [numTurns]

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState } from "./dndMechanics.js";

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-3.1-flash-lite",
  GEMINI_GROUNDING_MODEL = "gemini-2.5-flash-lite",
  DEFAULT_LOCATION = "Vientiane, Laos",
  DEFAULT_TIMEZONE = "Asia/Vientiane",
} = process.env;

if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__drift_test_${Date.now()}__`;
const MAX_DND_TOOL_STEPS = 12; // must match index.js
const DND_HISTORY_COMPACT_THRESHOLD = 14; // must match index.js
const DND_HISTORY_KEEP_RECENT = 10; // must match index.js

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free-tier quota is 15 req/min for gemini-3.1-flash-lite (discovered by running this harness
// unpaced — hit a 429 on turn 5). Real play is nowhere near this dense since players type at
// human speed, but the harness self-plays with zero delay, so it needs its own pacing to get
// a clean multi-turn run instead of tripping the same limit itself.
const MIN_CALL_INTERVAL_MS = 4300;
let lastCallAt = 0;

function extractRetryDelayMs(err) {
  const match = String(err?.message || "").match(/retry in ([\d.]+)s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) + 1000 : 15000;
}

async function generateContentPaced(params, { retries = 2 } = {}) {
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  try {
    return await ai.models.generateContent(params);
  } catch (err) {
    if (err?.status === 429 && retries > 0) {
      const delay = extractRetryDelayMs(err);
      console.log(`  (429 rate limit — waiting ${Math.round(delay / 1000)}s before retry, ${retries} retr${retries === 1 ? "y" : "ies"} left)`);
      await sleep(delay);
      lastCallAt = Date.now();
      return generateContentPaced(params, { retries: retries - 1 });
    }
    throw err;
  }
}
const NUM_TURNS = Math.max(1, parseInt(process.argv[2], 10) || 20);

function buildLocalizationContext() {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
  return `LOCALIZATION CONTEXT: Right now it is ${formatted} in ${DEFAULT_LOCATION} (UTC+7).`;
}

// Heuristics for "the model wrote the tool call out instead of invoking it" — a leaked
// function-call-shaped fragment in plain narration text.
const TOOL_NAMES = DND_FUNCTION_DECLARATIONS.map((d) => d.name);
const LEAK_CALL_PATTERN = new RegExp(`\\b(${TOOL_NAMES.join("|")})\\s*\\(`, "i");
const LEAK_JSON_PATTERN = /"name"\s*:\s*"(?:[a-z_]+)"|```(?:json|tool_code|python)?/i;
const LEAK_META_PATTERN = /\bfunction[_ ]?call\b|\btool_code\b|\bprint\(/i;
function detectCallLeak(text) {
  if (!text) return null;
  if (LEAK_CALL_PATTERN.test(text)) return "tool-name-as-call";
  if (LEAK_JSON_PATTERN.test(text)) return "json/code-fence";
  if (LEAK_META_PATTERN.test(text)) return "meta-language";
  return null;
}
// Secondary, softer heuristic: mechanical numbers narrated without the matching tool having
// run this step — much noisier, so just logged as a warning, never treated as confirmed drift.
const MECH_NUMBER_PATTERN = /\b\d+\s*(hp|damage|dmg|exp|xp|gold)\b/i;

const driftEvents = [];
const stepSamples = [];

function logStep({ turn, step, promptChars, hadCall, callName, leak, text }) {
  stepSamples.push({ turn, step, promptChars, hadCall, callName });
  const tag = hadCall ? `call=${callName}` : leak ? `NO-CALL leak=${leak}` : "NO-CALL (narration)";
  console.log(`  [turn ${turn} step ${step}] prompt~${promptChars}ch ${tag}`);
  if (leak) {
    console.log(`    ⚠ possible drift — raw text:\n${text.split("\n").map((l) => "      " + l).join("\n")}`);
    driftEvents.push({ turn, step, kind: "leak", detail: leak, text });
  } else if (!hadCall && MECH_NUMBER_PATTERN.test(text || "")) {
    console.log(`    ~ mechanical-sounding narration with no tool call this step (soft flag)`);
    driftEvents.push({ turn, step, kind: "soft-mechanic", text });
  }
}

async function runInstrumentedLoop(contents, systemInstruction, tools, turnLabel) {
  for (let step = 0; step < MAX_DND_TOOL_STEPS; step++) {
    const promptChars = JSON.stringify(contents).length + systemInstruction.length;
    const response = await generateContentPaced({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction, temperature: 1.1, maxOutputTokens: 1200, tools },
    });

    // Mirrors runDndLoop in index.js post-fix: handle EVERY function call in the response, not
    // just the first — Gemini sometimes bundles several (e.g. spawn_monster + apply_damage) in
    // one turn, and leaving any of them unanswered corrupts the next request's history.
    const calls = (response.functionCalls || []).filter((c) => isDndAction(c.name));
    const text = response.text?.trim() || "";

    if (!calls.length) {
      const leak = detectCallLeak(text);
      logStep({ turn: turnLabel, step, promptChars, hadCall: false, callName: null, leak, text });
      if (!text) throw new Error("Empty response from Gemini");
      return { text, stepsUsed: step + 1 };
    }

    logStep({
      turn: turnLabel,
      step,
      promptChars,
      hadCall: true,
      callName: calls.length > 1 ? `${calls.map((c) => c.name).join("+")} (${calls.length} parallel)` : calls[0].name,
      leak: null,
      text,
    });

    const resolvedParts = [];
    for (const call of calls) {
      const resultText = await runDndAction(call.name, call.args, { channelId: TEST_CHANNEL });
      // Test harness auto-reveals skill_check immediately instead of pausing for a 🎲 click
      // (see file header) — so unlike production, every call in the batch is just answered
      // right away in the same functionResponse turn.
      resolvedParts.push({ functionResponse: { name: call.name, response: { output: resultText } } });
    }

    contents = [...contents, response.candidates[0].content, { role: "user", parts: resolvedParts }];
  }

  // Hit the step cap — mirror index.js's forced-narration fallback call.
  const promptChars = JSON.stringify(contents).length + systemInstruction.length;
  const finalResponse = await generateContentPaced({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction:
        systemInstruction +
        "\n\n[You are out of tool calls for this turn. Narrate only what's already been resolved.]",
      temperature: 1.1,
      maxOutputTokens: 1200,
    },
  });
  const finalText = finalResponse.text?.trim() || "";
  const leak = detectCallLeak(finalText);
  logStep({ turn: turnLabel, step: MAX_DND_TOOL_STEPS, promptChars, hadCall: false, callName: null, leak, text: finalText });
  console.log(`    !! HIT MAX_DND_TOOL_STEPS (${MAX_DND_TOOL_STEPS}) this turn`);
  if (!finalText) throw new Error("Empty response from Gemini (step-cap fallback)");
  return { text: finalText, stepsUsed: MAX_DND_TOOL_STEPS };
}

async function summarizeHistory(oldSummary, turnsToCompact) {
  const transcript = turnsToCompact
    .map((t) => `${t.role === "user" ? "Player" : "Ayame"}: ${t.parts?.[0]?.text ?? ""}`)
    .join("\n");
  const prompt =
    (oldSummary ? `EXISTING SUMMARY SO FAR:\n${oldSummary}\n\n` : "") +
    `NEW EVENTS TO FOLD IN:\n${transcript}\n\nCondense into an updated compact running summary.`;
  const res = await generateContentPaced({
    model: GEMINI_GROUNDING_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      systemInstruction: "You condense tabletop RPG session logs into compact recaps. No roleplay, no persona.",
      maxOutputTokens: 300,
    },
  });
  return res.text?.trim() || oldSummary || "";
}

// Scripted, deliberately chaotic multi-clause player turns — each one bundles several
// distinct actions/targets in one message to encourage the model to chain multiple tool calls
// (skill_check -> apply_damage -> monster_attack -> apply_damage -> add_exp -> loot -> ...)
// within a single turn, which is where MAX_DND_TOOL_STEPS pressure actually builds up.
const SCRIPT = [
  "We push into the ruins. I (alice_test) kick open the door while bob_test covers me.",
  "A massive Ancient Wyrm bursts out of the rubble, snarling! Alice charges in swinging her greatsword at its head.",
  "Bob fires three arrows in quick succession at its wings while Alice keeps it distracted in melee.",
  "The wyrm rakes its claws at both of us — we scramble to dodge and immediately counterattack.",
  "Alice presses the attack again going for a finishing blow, while Bob tries to hit its exposed underbelly.",
  "The wyrm breathes fire across the room! We both dive for cover and Alice tries to shield Bob.",
  "We finish it off — Alice delivers the killing blow while Bob searches the corpse for anything valuable.",
  "We loot the wyrm's hoard, split the gold between us, and Alice drinks a potion to patch up her wounds.",
  "We travel to the nearest town, sell off the extra loot at the market, and buy fresh supplies.",
  "A gang of bandits ambushes us on the road out of town — we fight back immediately, no time to talk.",
  "Alice tries to intimidate the bandit leader into surrendering while Bob picks off the others with his bow.",
  "The bandit leader refuses and lunges at Alice with a dagger — she blocks and retaliates hard.",
  "We finish the bandits, loot their camp, and Bob tries to pick the lock on their strongbox.",
  "We report back to the town guard for a reward, then head to the tavern to rest and celebrate.",
  "A hooded stranger challenges Alice to a duel right there in the tavern — she accepts.",
  "The duel begins — Alice and the stranger trade blows rapidly while Bob watches the crowd for foul play.",
  "Alice lands a decisive hit to end the duel, then the stranger reveals a cryptic warning about a bigger threat.",
  "We rest for the night, then set out at dawn toward the source of that warning.",
  "We find a cave guarded by two smaller wyrmlings — we split up and attack both at once.",
  "With the wyrmlings dealt with, we press deeper into the cave toward whatever the stranger warned us about.",
];

async function main() {
  await loadDndSessions();

  await createCharacter(
    TEST_CHANNEL,
    "alice_test",
    "user-alice",
    { str: 30, dex: 15, con: 25, int: 10, wis: 10, cha: 10 },
    "Lionelius Maximus The 3rd",
    "Warrior",
    "Grew up a blacksmith's apprentice."
  );
  await createCharacter(
    TEST_CHANNEL,
    "bob_test",
    "user-bob",
    { str: 10, dex: 30, con: 15, int: 10, wis: 20, cha: 15 },
    null,
    "Rogue",
    "Former city guard, sharp eyes."
  );

  let sessionHistory = [];
  let summary = "";
  let turnCount = 0;

  console.log(`Model: ${GEMINI_MODEL} | test channel: ${TEST_CHANNEL} | turns: ${Math.min(NUM_TURNS, SCRIPT.length)}\n`);

  try {
    for (let i = 0; i < Math.min(NUM_TURNS, SCRIPT.length); i++) {
      const userText = SCRIPT[i];
      console.log(`\n=== TURN ${i + 1}/${Math.min(NUM_TURNS, SCRIPT.length)} (exchange ${turnCount}) ===`);
      console.log(`Player: ${userText}`);

      sessionHistory.push({ role: "user", parts: [{ text: userText }] });

      const partyStatus = buildPartyStatusText(TEST_CHANNEL);
      const systemInstruction =
        AYAME_DM_PERSONA +
        buildDndInstructions({ theme: "a dragon-hunting one-shot", turnCount, partyStatus, storySummary: summary }) +
        `\n\n${buildLocalizationContext()}`;
      const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

      const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, i + 1);
      console.log(`Ayame: ${result.text.slice(0, 300)}${result.text.length > 300 ? "…" : ""}`);
      console.log(`  (${result.stepsUsed} tool-loop step(s) this turn)`);

      sessionHistory.push({ role: "model", parts: [{ text: result.text }] });
      turnCount++;

      if (sessionHistory.length > DND_HISTORY_COMPACT_THRESHOLD) {
        const toCompact = sessionHistory.slice(0, sessionHistory.length - DND_HISTORY_KEEP_RECENT);
        const toKeep = sessionHistory.slice(sessionHistory.length - DND_HISTORY_KEEP_RECENT);
        console.log(`  (compacting ${toCompact.length} old entries into summary...)`);
        summary = await summarizeHistory(summary, toCompact);
        sessionHistory = toKeep;
      }
    }
  } finally {
    console.log("\nCleaning up test channel data...");
    await clearMechanicsState(TEST_CHANNEL);
  }

  console.log("\n\n========== SUMMARY ==========");
  console.log(`Turns run: ${Math.min(NUM_TURNS, SCRIPT.length)}`);
  console.log(`Total generateContent steps: ${stepSamples.length}`);
  const capHits = stepSamples.filter((s) => s.step === MAX_DND_TOOL_STEPS).length;
  console.log(`Turns that hit MAX_DND_TOOL_STEPS: ${capHits}`);
  console.log(`Drift events (leaked call syntax / suspicious narration): ${driftEvents.length}`);
  if (driftEvents.length) {
    for (const ev of driftEvents) {
      console.log(`  - turn ${ev.turn} step ${ev.step} [${ev.kind}${ev.detail ? ":" + ev.detail : ""}]`);
    }
    console.log("\nFull text of drift events printed above during the run — scroll up to inspect.");
  } else {
    console.log("No leaked tool-call-as-text detected in this run.");
  }
}

main().catch((err) => {
  console.error("Fatal error during drift test:", err);
  process.exitCode = 1;
});
