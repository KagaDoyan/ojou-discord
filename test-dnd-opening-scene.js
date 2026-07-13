// test-dnd-opening-scene.js
// Focused live check for the OPENING SCENE persona instruction added this session: the very
// first exchange of a session (no theme given, no location dictated by the player) should place
// the party somewhere safe with shop access — not straight into danger — and starter gear
// should already be present without the DM re-granting it narratively.
//
// Run: bun test-dnd-opening-scene.js

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState, getCharacterSheet } from "./dndMechanics.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.1-flash-lite", DEFAULT_LOCATION = "Vientiane, Laos", DEFAULT_TIMEZONE = "Asia/Vientiane" } = process.env;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__opening_scene_test_${Date.now()}__`;
const MAX_DND_TOOL_STEPS = 8;
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

const toolCallLog = [];

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
      toolCallLog.push({ turn: turnLabel, name: call.name, args: call.args, result: resultText });
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

// Deliberately vague opener — doesn't dictate a location itself, so the DM has to decide where
// to open the scene on its own (that's the whole point of this test).
const SCRIPT = [
  { user: "alice_test", text: "Alright, I'm ready — let's begin!" },
  { user: "alice_test", text: "I take a look around and see what's nearby to buy before we head out." },
];

async function main() {
  await loadDndSessions();
  await createCharacter(TEST_CHANNEL, "alice_test", "user-alice", { str: 20, dex: 20, con: 20, int: 15, wis: 15, cha: 10 }, "Alice", "Ranger", null);

  const startingSheet = getCharacterSheet(TEST_CHANNEL, "alice_test");
  console.log(`Model: ${GEMINI_MODEL} | test channel: ${TEST_CHANNEL}`);
  console.log(
    `Starting sheet (from /create_character, before any DM turn): HP ${startingSheet.character.currentHp}/${startingSheet.character.maxHp}, ` +
      `Gold ${startingSheet.gold}, Inventory: ${startingSheet.inventory.map((i) => `${i.item} x${i.quantity}`).join(", ")}`
  );

  let sessionHistory = [];
  let turnCount = 0;

  try {
    for (let i = 0; i < SCRIPT.length; i++) {
      const { user, text: userText } = SCRIPT[i];
      console.log(`\n=== TURN ${i + 1}/${SCRIPT.length} (${user}) ===`);
      console.log(`Player: ${userText}`);
      sessionHistory.push({ role: "user", parts: [{ text: `[${user}]: ${userText}` }] });

      const partyStatus = buildPartyStatusText(TEST_CHANNEL);
      // No theme given — forces the DM to either ask what's wanted or improvise the opening
      // itself, exactly the branch the OPENING SCENE instruction is meant to constrain.
      const systemInstruction =
        AYAME_DM_PERSONA + buildDndInstructions({ theme: null, turnCount, partyStatus, storySummary: "" }) + `\n\n${buildLocalizationContext()}`;
      const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

      const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, i + 1);
      console.log(`Ayame: ${result.text}`);
      sessionHistory.push({ role: "model", parts: [{ text: result.text }] });
      turnCount++;
    }

    console.log("\n########## VERDICT ##########");
    const openingText = sessionHistory[1]?.parts?.[0]?.text || "";
    const dangerWords = /\b(ambush|attacks?( you)?|monster (leaps|lunges|charges)|combat begins|you're surrounded|blood|claws rake|snarling|roars? and (charges|lunges))\b/i;
    const safeWords = /\b(village|town|market|inn|tavern|shop|merchant|stall|square|trading post|settlement|outpost|station)\b/i;
    const flaggedDanger = dangerWords.test(openingText);
    const mentionsSafeHub = safeWords.test(openingText);
    console.log(`Opening narration mentions a safe-hub keyword (village/town/market/etc.): ${mentionsSafeHub}`);
    console.log(`Opening narration contains danger-language: ${flaggedDanger}`);
    console.log(mentionsSafeHub && !flaggedDanger ? "PASS: opening scene reads as a safe hub." : "NEEDS MANUAL REVIEW: check the transcript above.");

    const regrantCalls = toolCallLog.filter((c) => c.name === "add_item" && String(c.args?.player_name || "").toLowerCase() === "alice_test");
    console.log(
      regrantCalls.length === 0
        ? "PASS: starter gear was not re-granted narratively (add_item never called for alice_test)."
        : `FAIL: DM re-granted starting gear via add_item: ${JSON.stringify(regrantCalls)}`
    );
  } finally {
    console.log("\nCleaning up test channel data...");
    await clearMechanicsState(TEST_CHANNEL);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
