// test-dnd-full-scenario.js
// Long combined live scenario exercising every mechanic and every persona fix from this
// session in one continuous, paced run: starter gear, class guard + on-the-spot justification,
// multi-monster combat (parallel function calls), NPC item gifts, fake item/equipment claims
// (should be denied), shopping, leveling, and character-name-not-Discord-handle in narration.
// Long enough to run through a real history compaction cycle too.
//
// Paced at ~4.3s/call to stay under the 15 req/min free-tier cap, with automatic 429 retry.
//
// Run: bun test-dnd-full-scenario.js

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState, getCharacterSheet } from "./dndMechanics.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.1-flash-lite", GEMINI_GROUNDING_MODEL = "gemini-2.5-flash-lite", DEFAULT_LOCATION = "Vientiane, Laos", DEFAULT_TIMEZONE = "Asia/Vientiane" } = process.env;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__full_scenario_${Date.now()}__`;
const MAX_DND_TOOL_STEPS = 12;
const DND_HISTORY_COMPACT_THRESHOLD = 14;
const DND_HISTORY_KEEP_RECENT = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_CALL_INTERVAL_MS = 4500; // slightly more conservative than earlier runs
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

// --- detectors ---
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
const ITEM_TRANSACTION_PATTERN =
  /\byou (find|discover|pick up|receive|buy|purchase|sell|obtain|pocket|take)\b|\bhands? you\b|\bgives? you\b|\bpresses?\b.{0,20}\binto your (hand|hands|palm)\b|\brewards? you\b|\badded to (your|the) (inventory|pack|bag)\b|\bgold (is now|drops? to)\b/i;
// Raw Discord usernames that should NEVER appear bolded in narration (flavor names only).
const USERNAMES = ["alice_test", "bob_test", "carol_test"];
const RAW_USERNAME_BOLD_PATTERN = new RegExp(`\\*\\*(${USERNAMES.join("|")})\\*\\*`, "i");

const findings = { leaks: [], itemFlags: [], rawUsernameBolds: [] };

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
      const leak = detectCallLeak(text);
      const itemFlag = ITEM_TRANSACTION_PATTERN.test(text);
      const usernameMatch = text.match(RAW_USERNAME_BOLD_PATTERN);
      console.log(`  [turn ${turnLabel} step ${step}] NO-CALL narration${leak ? "  ⚠ LEAK:" + leak : ""}${itemFlag ? "  ~item-language" : ""}${usernameMatch ? "  ⚠ RAW USERNAME BOLDED:" + usernameMatch[1] : ""}`);
      if (leak) findings.leaks.push({ turn: turnLabel, step, text });
      if (itemFlag) findings.itemFlags.push({ turn: turnLabel, step, text });
      if (usernameMatch) findings.rawUsernameBolds.push({ turn: turnLabel, step, text, username: usernameMatch[1] });
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
  console.log(`  [turn ${turnLabel} step CAP] forced narration (hit MAX_DND_TOOL_STEPS)`);
  return { text: finalText, stepsUsed: MAX_DND_TOOL_STEPS };
}

async function summarizeHistory(oldSummary, turnsToCompact) {
  const transcript = turnsToCompact.map((t) => `${t.role === "user" ? "Player" : "Ayame"}: ${t.parts?.[0]?.text ?? ""}`).join("\n");
  const prompt = (oldSummary ? `EXISTING SUMMARY SO FAR:\n${oldSummary}\n\n` : "") + `NEW EVENTS TO FOLD IN:\n${transcript}\n\nCondense into an updated compact running summary.`;
  const res = await generateContentPaced({
    model: GEMINI_GROUNDING_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: "You condense tabletop RPG session logs into compact recaps. No roleplay, no persona.", maxOutputTokens: 300 },
  });
  return res.text?.trim() || oldSummary || "";
}

const SCRIPT = [
  { user: "alice_test", text: "I step through the gate into the ruins, ready for whatever's inside." },
  { user: "bob_test", text: "I sneak in behind her, keeping to the shadows." },
  { user: "carol_test", text: "I follow, murmuring a minor incantation to light the tip of my staff." },
  { user: "alice_test", text: "I try to force open the jammed portcullis blocking the main hall." },
  { user: "bob_test", text: "While she's busy with that, I try to pick the lock on the side door instead." },
  { user: "alice_test", text: "I raise my hand and try to cast a healing spell on myself." },
  { user: "alice_test", text: "Actually — I once served briefly as a battle-cleric's squire and picked up a few minor blessings before becoming a knight." },
  { user: "carol_test", text: "Two goblins leap out from behind a pillar! I blast them both with a firebolt spell." },
  { user: "bob_test", text: "I flank around and stab the wounded one with my daggers." },
  { user: "alice_test", text: "I charge in and finish off the last goblin with my sword." },
  { user: "bob_test", text: "We loot the goblins' camp for anything valuable lying around." },
  { user: "alice_test", text: "A wandering merchant we helped earlier catches up to us and gives each of us a health potion as thanks." },
  { user: "carol_test", text: "I drink one of the health potions right now, just to top myself up." },
  { user: "alice_test", text: "I drink a Potion of Fire Immunity and dive straight into the burning wreckage ahead." },
  { user: "bob_test", text: "I draw my legendary vorpal blade and attack the nearest enemy with it." },
  { user: "carol_test", text: "We reach a trading post. I want to buy a proper spellbook from the merchant there." },
  { user: "bob_test", text: "I sell one of my daggers to the same merchant for whatever she'll give me." },
  { user: "alice_test", text: "We report back to the guard captain about clearing the goblins, hoping for a reward." },
  { user: "carol_test", text: "A massive ogre bursts out of a side passage, roaring! I hit it with everything I've got." },
  { user: "bob_test", text: "I dash in and strike at its exposed leg while it's distracted." },
  { user: "alice_test", text: "I press the attack too, going for a decisive blow." },
  { user: "carol_test", text: "The ogre swings back wildly — we all try to scramble out of the way." },
  { user: "bob_test", text: "I finish it off with a precise strike to its throat." },
  { user: "alice_test", text: "We search the ogre's lair for any treasure before moving on." },
  { user: "carol_test", text: "We make camp for the night to rest and recover." },
  { user: "bob_test", text: "At first light, I ask the others which way we should head next." },
];

async function main() {
  await loadDndSessions();
  await createCharacter(TEST_CHANNEL, "alice_test", "user-alice", { str: 25, dex: 15, con: 20, int: 15, wis: 10, cha: 10 }, "Ser Alistair", "Knight", null);
  await createCharacter(TEST_CHANNEL, "bob_test", "user-bob", { str: 15, dex: 25, con: 15, int: 10, wis: 15, cha: 10 }, "Shadowfoot", "Rogue", "Grew up as a street thief in the capital.");
  await createCharacter(TEST_CHANNEL, "carol_test", "user-carol", { str: 10, dex: 15, con: 15, int: 25, wis: 20, cha: 10 }, "Lyra Moonveil", "Mage", null);

  let sessionHistory = [];
  let summary = "";
  let turnCount = 0;
  console.log(`Model: ${GEMINI_MODEL} | test channel: ${TEST_CHANNEL} | turns: ${SCRIPT.length}\n`);

  try {
    for (let i = 0; i < SCRIPT.length; i++) {
      const { user, text: userText } = SCRIPT[i];
      console.log(`\n=== TURN ${i + 1}/${SCRIPT.length} (${user}, exchange ${turnCount}) ===`);
      console.log(`Player: ${userText}`);
      sessionHistory.push({ role: "user", parts: [{ text: `[${user}]: ${userText}` }] });

      const partyStatus = buildPartyStatusText(TEST_CHANNEL);
      const systemInstruction =
        AYAME_DM_PERSONA + buildDndInstructions({ theme: "a ruined dungeon crawl, into a market town, into a monster lair", turnCount, partyStatus, storySummary: summary }) + `\n\n${buildLocalizationContext()}`;
      const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

      const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, i + 1);
      console.log(`Ayame: ${result.text.slice(0, 280)}${result.text.length > 280 ? "…" : ""}`);
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

    console.log("\n\n========== FINAL SHEETS ==========");
    for (const name of ["alice_test", "bob_test", "carol_test"]) {
      const sheet = getCharacterSheet(TEST_CHANNEL, name);
      console.log(
        `${name}: Lvl ${sheet.character.level}, HP ${sheet.character.currentHp}/${sheet.character.maxHp}, EXP ${sheet.character.exp}/${sheet.character.level * 100}, Gold ${sheet.gold}`
      );
      console.log(`  Inventory: ${sheet.inventory.map((i) => `${i.item} x${i.quantity}`).join(", ") || "(empty)"}`);
    }
  } finally {
    console.log("\nCleaning up test channel data...");
    await clearMechanicsState(TEST_CHANNEL);
  }

  console.log("\n\n========== SUMMARY ==========");
  console.log(`Turns run: ${SCRIPT.length}`);
  console.log(`Leaked tool-call-as-text events: ${findings.leaks.length}`);
  for (const f of findings.leaks) console.log(`  - turn ${f.turn} step ${f.step}`);
  console.log(`Item-transaction-language flags (manual review recommended): ${findings.itemFlags.length}`);
  for (const f of findings.itemFlags) console.log(`  - turn ${f.turn} step ${f.step}`);
  console.log(`Raw Discord username bolded in narration: ${findings.rawUsernameBolds.length}`);
  for (const f of findings.rawUsernameBolds) console.log(`  - turn ${f.turn} step ${f.step} (${f.username})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
