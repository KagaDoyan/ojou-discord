// test-dnd-death-revival.js
// Live-model repro/verification for the death & revival mechanics added to dndMechanics.js /
// persona.js: (1) a character at 0 HP must not be able to act, (2) an ally's resurrection magic
// (skill_check -> revive_character with cost 0) should bring them back, (3) a paid temple
// service (revive_character with cost > 0) should work as a fallback path. Death is forced
// directly via apply_damage (bypassing the model) so the scenario doesn't depend on combat RNG
// to land a kill — only the post-death behavior is being verified here.
//
// Run: bun test-dnd-death-revival.js

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import { DND_FUNCTION_DECLARATIONS, isDndAction, runDndAction, loadDndSessions, createCharacter, buildPartyStatusText } from "./dnd.js";
import { clearMechanicsState, getCharacterSheet, runMechanicsAction } from "./dndMechanics.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.1-flash-lite", DEFAULT_LOCATION = "Vientiane, Laos", DEFAULT_TIMEZONE = "Asia/Vientiane" } = process.env;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEST_CHANNEL = `__death_revival_test_${Date.now()}__`;
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

// alice_test: Knight — gets forced to 0 HP directly (bypassing combat RNG) to test the dead
// state. bob_test: Cleric with a magic-adjacent background — attempts resurrection magic.
const SCRIPT_PHASE_1 = [
  { user: "alice_test", text: "I'm down, but I grit my teeth and try to drag myself up to swing my sword at the nearest threat anyway!" },
  { user: "bob_test", text: "I rush to Alice's side and kneel over her, desperately channeling every bit of healing magic I have to try to bring her back!" },
];
// Only runs if phase 1's resurrection attempt didn't succeed (dice-dependent) — gives the
// spellcaster a second shot before falling back to the paid path.
const SCRIPT_PHASE_1_RETRY = [
  { user: "bob_test", text: "I steady my breathing and try the resurrection ritual again, pouring everything I have into it this time." },
];
// Forces a second death, then tests the paid temple path instead of magic.
const SCRIPT_PHASE_2 = [
  { user: "bob_test", text: "We carry Alice's body into the nearest town and bring her to the temple, asking the priest there to resurrect her for whatever fee they charge." },
];
// Follow-up in case the DM negotiates the fee in narration first before actually charging it.
const SCRIPT_PHASE_2_CONFIRM = [
  { user: "bob_test", text: "Yes, whatever it costs — please pay the priest and bring her back right now." },
];

async function playScript(script, sessionHistory, turnCountRef) {
  for (const { user, text: userText } of script) {
    turnCountRef.count++;
    console.log(`\n=== ${user}: "${userText}" ===`);
    sessionHistory.push({ role: "user", parts: [{ text: `[${user}]: ${userText}` }] });

    const partyStatus = buildPartyStatusText(TEST_CHANNEL);
    const systemInstruction =
      AYAME_DM_PERSONA +
      buildDndInstructions({ theme: "a dungeon-crawl one-shot", turnCount: turnCountRef.count, partyStatus, storySummary: "" }) +
      `\n\n${buildLocalizationContext()}`;
    const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

    const result = await runInstrumentedLoop([...sessionHistory], systemInstruction, tools, turnCountRef.count);
    console.log(`Ayame: ${result.text}`);
    sessionHistory.push({ role: "model", parts: [{ text: result.text }] });
  }
}

function printSheets(label) {
  console.log(`\n--- ${label} ---`);
  for (const name of ["alice_test", "bob_test"]) {
    const sheet = getCharacterSheet(TEST_CHANNEL, name);
    console.log(
      `${name}: HP ${sheet.character.currentHp}/${sheet.character.maxHp}${sheet.character.currentHp <= 0 ? " (DEAD)" : ""}, ` +
        `Gold ${sheet.gold}, Inventory: ${sheet.inventory.map((i) => `${i.item} x${i.quantity}`).join(", ") || "(empty)"}`
    );
  }
}

async function main() {
  await loadDndSessions();
  await createCharacter(TEST_CHANNEL, "alice_test", "user-alice", { str: 25, dex: 15, con: 20, int: 10, wis: 10, cha: 20 }, "Alice", "Knight", null);
  await createCharacter(
    TEST_CHANNEL,
    "bob_test",
    "user-bob",
    { str: 10, dex: 10, con: 15, int: 15, wis: 25, cha: 25 },
    "Bob",
    "Cleric",
    "A devoted temple healer trained in resurrection rites."
  );

  console.log(`Model: ${GEMINI_MODEL} | test channel: ${TEST_CHANNEL}`);
  const turnCountRef = { count: 0 };
  let sessionHistory = [];

  try {
    // --- Phase 1: force a death, verify the dead character can't act, then try magic revival ---
    console.log("\n########## PHASE 1: forced death + resurrection magic attempt ##########");
    let r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice_test", amount: 9999 }, { channelId: TEST_CHANNEL });
    console.log(`(direct, bypassing model) apply_damage -> ${r}`);
    printSheets("state after forced death");

    await playScript(SCRIPT_PHASE_1, sessionHistory, turnCountRef);

    let sheet = getCharacterSheet(TEST_CHANNEL, "alice_test");
    if (sheet.character.currentHp <= 0) {
      console.log("\n(Alice still dead after first resurrection attempt — retrying once, magic is dice-dependent)");
      await playScript(SCRIPT_PHASE_1_RETRY, sessionHistory, turnCountRef);
      sheet = getCharacterSheet(TEST_CHANNEL, "alice_test");
    }
    printSheets("state after phase 1");

    // --- Phase 2: force a second death, verify the paid temple path works as a fallback ---
    console.log("\n########## PHASE 2: forced death + paid temple revival ##########");
    r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice_test", amount: 9999 }, { channelId: TEST_CHANNEL });
    console.log(`(direct, bypassing model) apply_damage -> ${r}`);
    await runMechanicsAction("modify_wallet", { player_name: "bob_test", amount: 200 }, { channelId: TEST_CHANNEL }); // ensure the party can afford the fee
    printSheets("state after second forced death (+200 gold given to bob for the temple fee)");

    await playScript(SCRIPT_PHASE_2, sessionHistory, turnCountRef);
    sheet = getCharacterSheet(TEST_CHANNEL, "alice_test");
    if (sheet.character.currentHp <= 0) {
      console.log("\n(Priest's fee was negotiated but not yet paid — confirming payment)");
      await playScript(SCRIPT_PHASE_2_CONFIRM, sessionHistory, turnCountRef);
    }
    printSheets("state after phase 2");

    // --- Verdict ---
    console.log("\n########## VERDICT ##########");
    const skillCheckOnDeadAlice = toolCallLog.filter(
      (c) => c.name === "skill_check" && String(c.args?.player_name || "").toLowerCase() === "alice_test" && c.result.startsWith("OK:")
    );
    console.log(
      skillCheckOnDeadAlice.length === 0
        ? "PASS: no successful skill_check was ever resolved for Alice while she was at 0 HP (the dead-state gate held)."
        : `FAIL: skill_check resolved OK for dead Alice: ${JSON.stringify(skillCheckOnDeadAlice)}`
    );

    const reviveCalls = toolCallLog.filter((c) => c.name === "revive_character");
    console.log(`revive_character calls made: ${reviveCalls.length}`);
    let illegitimateRevives = 0;
    reviveCalls.forEach((c) => {
      const cost = Number(c.args?.cost) || 0;
      const sameTurnCalls = toolCallLog.filter((x) => x.turn === c.turn);
      const backedBySkillCheck = sameTurnCalls.some(
        (x) =>
          x.name === "skill_check" &&
          x.result.includes("SUCCESS") &&
          String(x.args?.player_name || "").toLowerCase() !== String(c.args?.player_name || "").toLowerCase()
      );
      const legitimate = cost > 0 || backedBySkillCheck;
      if (!legitimate) illegitimateRevives++;
      console.log(`  - ${JSON.stringify(c.args)} => ${c.result} [${legitimate ? "legitimate" : "SUSPICIOUS — no cost and no backing skill_check this turn"}]`);
    });
    console.log(
      illegitimateRevives === 0
        ? "PASS: every revive_character call was backed by either a paid cost or a same-turn successful skill_check from another character."
        : `FAIL: ${illegitimateRevives} revive_character call(s) look speculative/unearned.`
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
