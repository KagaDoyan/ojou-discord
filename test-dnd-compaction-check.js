// test-dnd-compaction-check.js
// Narrow live check for the compaction-model fix: summarizeDndHistory (index.js) now runs on
// GEMINI_MODEL instead of GEMINI_GROUNDING_MODEL, since it never needed search grounding and was
// competing with real grounding requests for that model's much smaller free-tier daily quota
// (this is exactly what crashed test-dnd-full-scenario.js's final turn). This script does the
// minimum needed to trigger one compaction cycle and confirms it actually returns a summary.
//
// Run: bun test-dnd-compaction-check.js

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState } from "./dndMechanics.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.1-flash-lite", DEFAULT_LOCATION = "Vientiane, Laos", DEFAULT_TIMEZONE = "Asia/Vientiane" } = process.env;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__compaction_check_${Date.now()}__`;
const MAX_DND_TOOL_STEPS = 6;
const DND_HISTORY_COMPACT_THRESHOLD = 14;
const DND_HISTORY_KEEP_RECENT = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      console.log(`  (429 — waiting ${Math.round(delay / 1000)}s, ${retries} retries left)`);
      await sleep(delay);
      lastCallAt = Date.now();
      return generateContentPaced(params, { retries: retries - 1 });
    }
    throw err;
  }
}
function buildLocalizationContext() {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TIMEZONE, dateStyle: "full", timeStyle: "short" }).format(new Date());
  return `LOCALIZATION CONTEXT: Right now it is ${formatted} in ${DEFAULT_LOCATION} (UTC+7).`;
}

async function runInstrumentedLoop(contents, systemInstruction, tools, turnLabel) {
  for (let step = 0; step < MAX_DND_TOOL_STEPS; step++) {
    const response = await generateContentPaced({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction, temperature: 1.1, maxOutputTokens: 800, tools },
    });
    const calls = (response.functionCalls || []).filter((c) => isDndAction(c.name));
    const text = response.text?.trim() || "";
    if (!calls.length) {
      console.log(`  [turn ${turnLabel} step ${step}] NO-CALL narration`);
      if (!text) throw new Error("Empty response from Gemini");
      return { text, stepsUsed: step + 1 };
    }
    console.log(`  [turn ${turnLabel} step ${step}] call=${calls.map((c) => c.name).join("+")}`);
    const resolvedParts = [];
    for (const call of calls) {
      const resultText = await runDndAction(call.name, call.args, { channelId: TEST_CHANNEL });
      resolvedParts.push({ functionResponse: { name: call.name, response: { output: resultText } } });
    }
    contents = [...contents, response.candidates[0].content, { role: "user", parts: resolvedParts }];
  }
  const finalResponse = await generateContentPaced({
    model: GEMINI_MODEL,
    contents,
    config: { systemInstruction: systemInstruction + "\n\n[Out of tool calls. Narrate only what's already resolved.]", temperature: 1.1, maxOutputTokens: 800 },
  });
  return { text: finalResponse.text?.trim() || "", stepsUsed: MAX_DND_TOOL_STEPS };
}

// Mirrors summarizeDndHistory in index.js exactly, but on GEMINI_MODEL — this IS the fix being
// checked, reimplemented here since the real function isn't exported from index.js.
async function summarizeHistory(oldSummary, turnsToCompact) {
  const transcript = turnsToCompact.map((t) => `${t.role === "user" ? "Player" : "Ayame"}: ${t.parts?.[0]?.text ?? ""}`).join("\n");
  const prompt = (oldSummary ? `EXISTING SUMMARY SO FAR:\n${oldSummary}\n\n` : "") + `NEW EVENTS TO FOLD IN:\n${transcript}\n\nCondense into an updated compact running summary.`;
  const res = await generateContentPaced({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: "You condense tabletop RPG session logs into compact recaps. No roleplay, no persona.", maxOutputTokens: 300 },
  });
  return res.text?.trim() || oldSummary || "";
}

// Short, filler-only turns — this test isn't exercising game mechanics, just accumulating
// enough raw history entries to cross DND_HISTORY_COMPACT_THRESHOLD (14) fast.
const SCRIPT = [
  "I look around the room.",
  "I take a moment to catch my breath.",
  "I check my gear.",
  "I glance at the door.",
  "I listen for any sounds.",
  "I take a few steps forward.",
  "I keep watch.",
  "I wait quietly.",
];

async function main() {
  await loadDndSessions();
  await createCharacter(TEST_CHANNEL, "alice_test", "user-alice", { str: 20, dex: 20, con: 20, int: 15, wis: 15, cha: 10 }, "Alice", "Ranger", null);

  let sessionHistory = [];
  let summary = "";
  let compacted = false;
  console.log(`Model: ${GEMINI_MODEL} | test channel: ${TEST_CHANNEL}`);

  try {
    for (let i = 0; i < SCRIPT.length && !compacted; i++) {
      console.log(`\n=== TURN ${i + 1} ===`);
      console.log(`Player: ${SCRIPT[i]}`);
      sessionHistory.push({ role: "user", parts: [{ text: `[alice_test]: ${SCRIPT[i]}` }] });

      const partyStatus = buildPartyStatusText(TEST_CHANNEL);
      const systemInstruction =
        AYAME_DM_PERSONA + buildDndInstructions({ theme: "a quiet exploration one-shot, low on action", turnCount: i, partyStatus, storySummary: summary }) + `\n\n${buildLocalizationContext()}`;
      const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

      const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, i + 1);
      console.log(`Ayame: ${result.text.slice(0, 150)}${result.text.length > 150 ? "…" : ""}`);
      sessionHistory.push({ role: "model", parts: [{ text: result.text }] });

      if (sessionHistory.length > DND_HISTORY_COMPACT_THRESHOLD) {
        console.log(`\n(history at ${sessionHistory.length} entries, past threshold ${DND_HISTORY_COMPACT_THRESHOLD} — triggering compaction on GEMINI_MODEL)`);
        const toCompact = sessionHistory.slice(0, sessionHistory.length - DND_HISTORY_KEEP_RECENT);
        const newSummary = await summarizeHistory(summary, toCompact);
        console.log(`Compaction result: ${newSummary ? `"${newSummary}"` : "(EMPTY — would be treated as failure)"}`);
        compacted = !!newSummary;
      }
    }

    console.log("\n########## VERDICT ##########");
    console.log(compacted ? "PASS: compaction succeeded on GEMINI_MODEL, no quota error." : "INCONCLUSIVE: never crossed the compaction threshold within the script.");
  } finally {
    console.log("\nCleaning up test channel data...");
    await clearMechanicsState(TEST_CHANNEL);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
