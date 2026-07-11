// test-dnd-guardrails.js
// Targeted repro/verification for three persona fixes: (1) CLASS GUARD should actively
// challenge an out-of-concept action in character instead of silently allowing/refusing it,
// (2) claiming to use an item you don't have (consumable or equipment) should be denied, not
// narrated as working, (3) a character with an empty Inventory should get starter gear early.
//
// Run: bun test-dnd-guardrails.js

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState, getCharacterSheet } from "./dndMechanics.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.1-flash-lite", DEFAULT_LOCATION = "Vientiane, Laos", DEFAULT_TIMEZONE = "Asia/Vientiane" } = process.env;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__guardrails_test_${Date.now()}__`;
const MAX_DND_TOOL_STEPS = 12;
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

// alice_test: Knight, no background — no items yet (tests starter gear + class guard).
// bob_test: Rogue with a background NOT related to magic either — used for the "no item" claim.
const SCRIPT = [
  { user: "alice_test", text: "I ready myself and step into the dungeon entrance, sword hand twitching with anticipation." },
  { user: "alice_test", text: "I raise my hand and cast a devastating fireball spell at the group of bandits ahead!" },
  { user: "alice_test", text: "Actually — my background: I secretly trained under a hedge wizard for two years before becoming a knight. So the fireball should work." },
  { user: "bob_test", text: "I drink a health potion to heal up." },
  { user: "bob_test", text: "I draw my greatsword and attack the nearest bandit." },
];

async function main() {
  await loadDndSessions();
  await createCharacter(TEST_CHANNEL, "alice_test", "user-alice", { str: 25, dex: 15, con: 20, int: 15, wis: 10, cha: 10 }, "Alice", "Knight", null);
  await createCharacter(TEST_CHANNEL, "bob_test", "user-bob", { str: 15, dex: 25, con: 15, int: 10, wis: 15, cha: 10 }, "Bob", "Rogue", "Grew up as a street thief in the capital.");

  let sessionHistory = [];
  let turnCount = 0;
  console.log(`Model: ${GEMINI_MODEL} | test channel: ${TEST_CHANNEL} | turns: ${SCRIPT.length}\n`);

  try {
    for (let i = 0; i < SCRIPT.length; i++) {
      const { user, text: userText } = SCRIPT[i];
      console.log(`\n=== TURN ${i + 1}/${SCRIPT.length} (${user}) ===`);
      console.log(`Player: ${userText}`);
      sessionHistory.push({ role: "user", parts: [{ text: `[${user}]: ${userText}` }] });

      const partyStatus = buildPartyStatusText(TEST_CHANNEL);
      const systemInstruction =
        AYAME_DM_PERSONA + buildDndInstructions({ theme: "a dungeon-crawl one-shot", turnCount, partyStatus, storySummary: "" }) + `\n\n${buildLocalizationContext()}`;
      const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

      const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, i + 1);
      console.log(`Ayame: ${result.text}`);
      sessionHistory.push({ role: "model", parts: [{ text: result.text }] });
      turnCount++;
    }

    console.log("\n\n========== FINAL SHEETS ==========");
    for (const name of ["alice_test", "bob_test"]) {
      const sheet = getCharacterSheet(TEST_CHANNEL, name);
      console.log(`${name}: HP ${sheet.character.currentHp}/${sheet.character.maxHp}, Gold ${sheet.gold}, Inventory: ${sheet.inventory.map((i) => `${i.item} x${i.quantity}`).join(", ") || "(empty)"}`);
    }
  } finally {
    console.log("\nCleaning up test channel data...");
    await clearMechanicsState(TEST_CHANNEL);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
