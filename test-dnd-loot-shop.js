// test-dnd-loot-shop.js
// Targeted repro for a live-play report: Ayame narrating an item being found, or a purchase
// completing, WITHOUT actually calling add_item/buy_item — so the mechanical state (inventory,
// gold) never changes even though the story says it did. Distinct from the parallel-function-
// call-drop bug fixed in index.js (that one corrupted history on multi-call turns; this is
// about the model skipping the tool call in the first place on a single, simple action).
//
// Drives the same prompt shape as askAyameDnd (real persona, real tools, real mechanics store)
// through a short, paced, loot/shop-focused scripted session and flags any turn where the
// narration talks about finding/buying/receiving/selling an item but no matching tool call
// happened that step.
//
// Run: bun test-dnd-loot-shop.js

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState, getCharacterSheet } from "./dndMechanics.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.1-flash-lite", DEFAULT_LOCATION = "Vientiane, Laos", DEFAULT_TIMEZONE = "Asia/Vientiane" } = process.env;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__loot_shop_test_${Date.now()}__`;
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

// The exact symptom reported: narration implies an item/gold change happened, phrased as
// something ALREADY completed ("you find", "you buy", "hands you", etc.), not offered/pending.
const ITEM_TRANSACTION_PATTERN =
  /\byou (find|discover|pick up|receive|buy|purchase|sell|obtain|pocket|take)\b|\bhands? you\b|\bgives? you\b|\bpresses?\b.{0,20}\binto your (hand|hands|palm)\b|\brewards? you\b|\badded to (your|the) (inventory|pack|bag)\b|\bgold (is now|drops? to)\b/i;

const ITEM_TOOLS = new Set(["add_item", "remove_item", "buy_item", "sell_item"]);

const flags = [];

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
      const suspicious = ITEM_TRANSACTION_PATTERN.test(text);
      console.log(`  [turn ${turnLabel} step ${step}] NO-CALL narration${suspicious ? "  ⚠ mentions an item/gold change with no tool call" : ""}`);
      if (suspicious) {
        console.log(`    text: ${text}`);
        flags.push({ turn: turnLabel, step, text });
      }
      if (!text) throw new Error("Empty response from Gemini");
      return { text, stepsUsed: step + 1 };
    }

    const calledItemTool = calls.some((c) => ITEM_TOOLS.has(c.name));
    console.log(`  [turn ${turnLabel} step ${step}] call=${calls.map((c) => c.name).join("+")}`);

    // Even when a tool WAS called this step, also check: does the accompanying narration text
    // (Gemini can emit text alongside a functionCall) already claim the transaction succeeded
    // before we've fed the result back? That's still jumping the gun on the GOLDEN RULE.
    if (text && ITEM_TRANSACTION_PATTERN.test(text) && !calledItemTool) {
      console.log(`    ⚠ narration alongside a non-item tool call still claims an item/gold change: ${text}`);
      flags.push({ turn: turnLabel, step, text, note: "narrated alongside unrelated tool call" });
    }

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
    config: {
      systemInstruction: systemInstruction + "\n\n[You are out of tool calls for this turn. Narrate only what's already been resolved.]",
      temperature: 1.1,
      maxOutputTokens: 1200,
    },
  });
  const finalText = finalResponse.text?.trim() || "";
  console.log(`  [turn ${turnLabel} step CAP] forced narration (hit MAX_DND_TOOL_STEPS)`);
  if (ITEM_TRANSACTION_PATTERN.test(finalText)) {
    console.log(`    ⚠ step-cap narration mentions an item/gold change: ${finalText}`);
    flags.push({ turn: turnLabel, step: "CAP", text: finalText });
  }
  return { text: finalText, stepsUsed: MAX_DND_TOOL_STEPS };
}

// Deliberately simple, isolated actions (not buried in a long combat chain) so if the tool
// still gets skipped, it's not explainable by step-budget pressure.
const SCRIPT = [
  "I pry open the old chest in the corner of the room and see what's inside.",
  "I pick up whatever's in the chest and put it in my bag.",
  "We head to the market square. I walk up to the blacksmith's stall and ask to buy a sturdy longsword.",
  "I also buy a wooden shield from the same blacksmith.",
  "I take my old rusty dagger to the shop and sell it for whatever they'll give me.",
  "The village elder thanks me for helping earlier and gives me a health potion as a reward.",
  "I want to buy 3 torches and a bedroll from the general store, all at once.",
  "I open my pack and check what I'm carrying.", // negative control: no transaction expected
];

async function main() {
  await loadDndSessions();
  await createCharacter(TEST_CHANNEL, "alice_test", "user-alice", { str: 20, dex: 20, con: 20, int: 10, wis: 10, cha: 20 }, "Alice", "Adventurer", null);

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
        AYAME_DM_PERSONA + buildDndInstructions({ theme: "a market-town errand-running one-shot", turnCount, partyStatus, storySummary: "" }) + `\n\n${buildLocalizationContext()}`;
      const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

      const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, i + 1);
      console.log(`Ayame: ${result.text.slice(0, 250)}${result.text.length > 250 ? "…" : ""}`);

      sessionHistory.push({ role: "model", parts: [{ text: result.text }] });
      turnCount++;
    }

    console.log("\n\n========== FINAL CHARACTER SHEET ==========");
    const sheet = getCharacterSheet(TEST_CHANNEL, "alice_test");
    console.log(`Gold: ${sheet.gold}`);
    console.log(`Inventory: ${sheet.inventory.map((i) => `${i.item} x${i.quantity}`).join(", ") || "(empty)"}`);
  } finally {
    console.log("\nCleaning up test channel data...");
    await clearMechanicsState(TEST_CHANNEL);
  }

  console.log("\n\n========== SUMMARY ==========");
  console.log(`Flags (narration claimed an item/gold change with no matching tool call): ${flags.length}`);
  for (const f of flags) console.log(`  - turn ${f.turn} step ${f.step}${f.note ? ` [${f.note}]` : ""}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
