// test-dnd-mechanics.js
// Pure logic correctness test for dndMechanics.js — no Gemini calls, no network. Calls the real
// deterministic mechanics functions through runMechanicsAction (the same entry point Gemini's
// tool calls go through in production) and asserts exact expected outcomes: HP clamping,
// EXP/leveling math, stat training + STAT_CAP enforcement, inventory add/remove, and the
// atomic buy/sell shop transactions. skill_check/monster_attack involve real dice, so those are
// checked structurally plus with a large-sample statistical sanity check instead of exact values.
//
// Writes through the real JSON stores under a throwaway channel id, deleted again at the end.
//
// Run: bun test-dnd-mechanics.js

import {
  loadMechanicsState,
  clearMechanicsState,
  createCharacter,
  getCharacter,
  getCharacterSheet,
  runMechanicsAction,
  trainStat,
  STAT_CAP,
} from "./dndMechanics.js";

const CHANNEL = `__mechanics_test_${Date.now()}__`;

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${msg}`);
  }
}
function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function main() {
  await loadMechanicsState();

  await createCharacter(
    CHANNEL,
    "alice",
    "uid-alice",
    { str: 20, dex: 20, con: 20, int: 10, wis: 10, cha: 10 },
    "Alice",
    "Warrior",
    null
  );
  let c = getCharacter(CHANNEL, "alice");
  assertEqual(c.maxHp, 30, "starting maxHp = 10 + con(20)");
  assertEqual(c.currentHp, 30, "starting currentHp = maxHp");
  assertEqual(c.level, 1, "starting level");
  assertEqual(c.exp, 0, "starting exp");

  // --- apply_damage (player HP) ---
  let r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: 10 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "apply_damage player damage returns OK: " + r);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 20, "HP after 10 damage");

  r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: 1000 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 0, "HP clamps at 0, not negative");
  assert(r.includes("knocked unconscious"), "massive damage reports knocked unconscious");

  r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: -1000 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, c.maxHp, "healing clamps at maxHp, doesn't overheal");

  // --- spawn_monster + apply_damage (monster HP) ---
  r = await runMechanicsAction("spawn_monster", { name: "Goblin", max_hp: 15 }, { channelId: CHANNEL });
  assert(r.includes("spawned with 15 HP"), "spawn_monster reports correct starting HP: " + r);

  r = await runMechanicsAction("apply_damage", { target_type: "monster", target_name: "Goblin", amount: 20 }, { channelId: CHANNEL });
  assert(r.includes("defeated"), "overkill damage marks monster defeated: " + r);
  assert(r.includes("0/15"), "monster HP clamps at 0: " + r);

  r = await runMechanicsAction("apply_damage", { target_type: "monster", target_name: "NoSuchMonster", amount: 5 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "damaging an unspawned monster errors: " + r);

  // --- add_exp / leveling ---
  r = await runMechanicsAction("add_exp", { player_name: "alice", amount: 250 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.level, 2, "level after 250 exp (100 to hit lvl2, 150 left)");
  assertEqual(c.exp, 150, "exp remainder after leveling to 2");
  assertEqual(c.maxHp, 35, "maxHp +5 on level up");
  assertEqual(c.currentHp, 35, "currentHp fully restored on level up");
  assertEqual(c.unspentStatPoints, 1, "1 unspent stat point after single level up");
  assert(r.includes("LEVEL UP"), "add_exp reports LEVEL UP: " + r);

  r = await runMechanicsAction("add_exp", { player_name: "alice", amount: 500 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  // from lvl2/exp150: +500 => exp650; lvl2 needs 200 -> exp450,lvl3; lvl3 needs300 -> exp150,lvl4; lvl4 needs400, stop.
  assertEqual(c.level, 4, "multi-level jump resolves correctly in one add_exp call");
  assertEqual(c.exp, 150, "exp remainder after a double level-up");
  assertEqual(c.unspentStatPoints, 3, "unspent points accumulate across level-ups (1 + 2 more)");

  r = await runMechanicsAction("add_exp", { player_name: "alice", amount: -5 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "negative exp is rejected: " + r);

  // --- /dnd train ---
  r = await trainStat(CHANNEL, "alice", "str", 2);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.stats.str, 22, "str after spending 2 points (20+2)");
  assertEqual(c.unspentStatPoints, 1, "unspent points decremented by spend");

  r = await trainStat(CHANNEL, "alice", "str", 5);
  assert(r.startsWith("ERROR:"), "spending more points than available errors: " + r);

  r = await trainStat(CHANNEL, "alice", "dex", 1);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.unspentStatPoints, 0, "last unspent point spent, none left");

  c.unspentStatPoints = 100; // test-only shortcut to reach the cap quickly, not earned normally
  r = await trainStat(CHANNEL, "alice", "str", STAT_CAP - c.stats.str);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.stats.str, STAT_CAP, "str trainable exactly up to STAT_CAP");

  r = await trainStat(CHANNEL, "alice", "str", 1);
  assert(r.startsWith("ERROR:") && r.includes(String(STAT_CAP)), "training past STAT_CAP is rejected: " + r);

  // --- modify_character_stat ---
  r = await runMechanicsAction("modify_character_stat", { player_name: "alice", stat: "cha", delta: 5 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.stats.cha, 15, "modify_character_stat +5 cha (10 -> 15)");

  r = await runMechanicsAction("modify_character_stat", { player_name: "alice", stat: "cha", delta: -100 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.stats.cha, 0, "modify_character_stat floors at 0");

  // --- wallet ---
  let sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 50, "starting gold");

  r = await runMechanicsAction("modify_wallet", { player_name: "alice", amount: 25 }, { channelId: CHANNEL });
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 75, "gold after +25");

  r = await runMechanicsAction("modify_wallet", { player_name: "alice", amount: -1000 }, { channelId: CHANNEL });
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 0, "gold floors at 0, doesn't go negative");

  // --- inventory: add/remove ---
  await runMechanicsAction("add_item", { player_name: "alice", item_name: "Torch", quantity: 2 }, { channelId: CHANNEL });
  await runMechanicsAction("add_item", { player_name: "alice", item_name: "Torch", quantity: 3 }, { channelId: CHANNEL });
  sheet = getCharacterSheet(CHANNEL, "alice");
  let torch = sheet.inventory.find((i) => i.item === "Torch");
  assertEqual(torch?.quantity, 5, "add_item accumulates same item quantity (2+3)");

  r = await runMechanicsAction("remove_item", { player_name: "alice", item_name: "Torch", quantity: 5 }, { channelId: CHANNEL });
  sheet = getCharacterSheet(CHANNEL, "alice");
  assert(!sheet.inventory.find((i) => i.item === "Torch"), "removing all of an item deletes its inventory entry");

  r = await runMechanicsAction("remove_item", { player_name: "alice", item_name: "Torch", quantity: 1 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "removing an item you don't have errors: " + r);

  // --- shop: buy/sell (atomic gold+item together) ---
  await runMechanicsAction("modify_wallet", { player_name: "alice", amount: 100 }, { channelId: CHANNEL });
  r = await runMechanicsAction("buy_item", { player_name: "alice", item_name: "Sword", price: 30, quantity: 2 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "buy_item succeeds when affordable: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 40, "gold deducted correctly on buy (100 - 60)");
  assertEqual(sheet.inventory.find((i) => i.item === "Sword")?.quantity, 2, "bought item added to inventory");

  r = await runMechanicsAction("buy_item", { player_name: "alice", item_name: "Castle", price: 10000, quantity: 1 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "buy_item rejects an unaffordable purchase: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 40, "gold unchanged after a failed purchase (no partial deduction)");

  r = await runMechanicsAction("sell_item", { player_name: "alice", item_name: "Sword", price: 15, quantity: 1 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "sell_item succeeds: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 55, "gold added correctly on sell (40 + 15)");
  assertEqual(sheet.inventory.find((i) => i.item === "Sword")?.quantity, 1, "sold quantity deducted from inventory");

  r = await runMechanicsAction("sell_item", { player_name: "alice", item_name: "Sword", price: 15, quantity: 5 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "selling more than you have errors: " + r);

  // --- skill_check: structural + statistical sanity (real dice, sampled) ---
  await createCharacter(CHANNEL, "statcheck", "uid-sc", { str: 40, dex: 0, con: 10, int: 10, wis: 10, cha: 10 }, null, "Tester", null);
  const trials = 200;

  let highSuccesses = 0;
  for (let i = 0; i < trials; i++) {
    r = await runMechanicsAction("skill_check", { player_name: "statcheck", stat: "str", difficulty: "easy", required_successes: 1 }, { channelId: CHANNEL });
    if (r.includes("SUCCESS")) highSuccesses++;
  }
  // str 40 -> modifier +8 vs DC 8: only a nat-1 fails (5% chance) -> expect ~95% success.
  assert(highSuccesses / trials > 0.85, `high-stat vs easy DC succeeds almost always (got ${highSuccesses}/${trials})`);

  let lowSuccesses = 0;
  for (let i = 0; i < trials; i++) {
    r = await runMechanicsAction("skill_check", { player_name: "statcheck", stat: "dex", difficulty: "very_hard", required_successes: 1 }, { channelId: CHANNEL });
    if (r.includes("SUCCESS")) lowSuccesses++;
  }
  // dex 0 -> modifier +0 vs DC 20: only a nat-20 succeeds (5% chance) -> expect ~5% success.
  assert(lowSuccesses / trials < 0.2, `zero-stat vs very_hard DC rarely succeeds (got ${lowSuccesses}/${trials})`);

  r = await runMechanicsAction("skill_check", { player_name: "statcheck", stat: "notastat", difficulty: "easy" }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "invalid stat name is rejected: " + r);

  r = await runMechanicsAction("skill_check", { player_name: "statcheck", stat: "str", difficulty: "easy", required_successes: 5 }, { channelId: CHANNEL });
  const successCountMatch = r.match(/\((\d+)\/(\d+) succeeded\)/);
  assert(!!successCountMatch && successCountMatch[2] === "5", "required_successes rolls exactly that many dice: " + r);

  // --- monster_attack ---
  await runMechanicsAction("spawn_monster", { name: "TrainingDummy", max_hp: 5 }, { channelId: CHANNEL });
  let hits = 0;
  for (let i = 0; i < trials; i++) {
    r = await runMechanicsAction("monster_attack", { monster_name: "TrainingDummy", target_player_name: "statcheck", defense_stat: "con" }, { channelId: CHANNEL });
    if (r.includes("HIT")) hits++;
  }
  assert(hits > 0 && hits < trials, `monster_attack produces a realistic mix of hits/misses (got ${hits}/${trials})`);

  r = await runMechanicsAction("monster_attack", { monster_name: "NoSuchMonster", target_player_name: "statcheck", defense_stat: "con" }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "attacking with an unspawned monster errors: " + r);

  await runMechanicsAction("apply_damage", { target_type: "monster", target_name: "TrainingDummy", amount: 999 }, { channelId: CHANNEL });
  r = await runMechanicsAction("monster_attack", { monster_name: "TrainingDummy", target_player_name: "statcheck", defense_stat: "con" }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:") && r.includes("already been defeated"), "a defeated monster can't attack: " + r);

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await clearMechanicsState(CHANNEL);
  });
