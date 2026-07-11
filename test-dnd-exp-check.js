// test-dnd-exp-check.js
// Short, focused verification: does add_exp actually get called right after a monster kill now
// that COMBAT & CHECKS explicitly ties it to apply_damage bringing a monster to 0 HP? The
// 26-turn full-scenario run found 5 kills and zero add_exp calls before this persona fix.
//
// Run: bun test-dnd-exp-check.js

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState, getCharacterSheet } from "./dndMechanics.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.1-flash-lite", DEFAULT_LOCATION = "Vientiane, Laos", DEFAULT_TIMEZONE = "Asia/Vientiane" } = process.env;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__exp_check_${Date.now()}__`;
const MAX_DND_TOOL_STEPS = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_CALL_INTERVAL_MS = 4500;
let lastCallAt = 0;
function extractRetryDelayMs(err) {
  const match = String(err?.message || "").match(/retry in ([\d.]+)s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) + 1500 : 16000;
}
async function generateContentPaced(params, { retries = 3 } = {}) {
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

let addExpCalls = 0;

async function runInstrumentedLoop(contents, systemInstruction, tools, turnLabel) {
  for (let step = 0; step < MAX_DND_TOOL_STEPS; step++) {
    const response = await generateContentPaced({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction, temperature: 1.1, maxOutputTokens: 1200, tools },
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
      if (call.name === "add_exp") addExpCalls++;
      const resultText = await runDndAction(call.name, call.args, { channelId: TEST_CHANNEL });
      console.log(`      -> ${call.name}(${JSON.stringify(call.args)}) => ${resultText}`);
      resolvedParts.push({ functionResponse: { name: call.name, response: { output: resultText } } });
    }
    contents = [...contents, response.candidates[0].content, { role: "user", parts: resolvedParts }];
  }
  const finalResponse = await generateContentPaced({
    model: GEMINI_MODEL,
    contents,
    config: { systemInstruction: systemInstruction + "\n\n[Out of tool calls. Narrate only what's already resolved.]", temperature: 1.1, maxOutputTokens: 1200 },
  });
  const finalText = finalResponse.text?.trim() || "";
  console.log(`  [turn ${turnLabel} step CAP] forced narration`);
  return { text: finalText, stepsUsed: MAX_DND_TOOL_STEPS };
}

const SCRIPT = [
  "A lone goblin jumps out and attacks! I swing my sword at it.",
  "I finish it off with another strike.",
  "Another goblin appears from the bushes! I attack it immediately.",
  "I press the attack to finish this one off too.",
];

async function main() {
  await loadDndSessions();
  await createCharacter(TEST_CHANNEL, "alice_test", "user-alice", { str: 30, dex: 15, con: 20, int: 10, wis: 10, cha: 10 }, "Ser Alistair", "Knight", null);

  let sessionHistory = [];
  let turnCount = 0;
  console.log(`Model: ${GEMINI_MODEL} | test channel: ${TEST_CHANNEL} | turns: ${SCRIPT.length}\n`);

  try {
    for (let i = 0; i < SCRIPT.length; i++) {
      const userText = SCRIPT[i];
      console.log(`\n=== TURN ${i + 1}/${SCRIPT.length} ===`);
      console.log(`Player: ${userText}`);
      sessionHistory.push({ role: "user", parts: [{ text: userText }] });

      const partyStatus = buildPartyStatusText(TEST_CHANNEL);
      const systemInstruction =
        AYAME_DM_PERSONA + buildDndInstructions({ theme: "a quick goblin skirmish", turnCount, partyStatus, storySummary: "" }) + `\n\n${buildLocalizationContext()}`;
      const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

      const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, i + 1);
      console.log(`Ayame: ${result.text.slice(0, 200)}${result.text.length > 200 ? "…" : ""}`);
      sessionHistory.push({ role: "model", parts: [{ text: result.text }] });
      turnCount++;
    }

    const sheet = getCharacterSheet(TEST_CHANNEL, "alice_test");
    console.log(`\n\nFinal: Lvl ${sheet.character.level}, EXP ${sheet.character.exp}/${sheet.character.level * 100}`);
    console.log(`add_exp calls this run: ${addExpCalls}`);
  } finally {
    await clearMechanicsState(TEST_CHANNEL);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
