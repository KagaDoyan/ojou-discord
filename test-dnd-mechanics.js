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

const TEST_STARTER_GOLD = 50;

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
  assertEqual(c.maxHp, 40, "starting maxHp = 20 + con(20)");
  assertEqual(c.currentHp, 40, "starting currentHp = maxHp");
  assertEqual(c.level, 1, "starting level");
  assertEqual(c.exp, 0, "starting exp");

  // --- apply_damage (player HP) ---
  let r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: 10 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "apply_damage player damage returns OK: " + r);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 30, "HP after 10 damage (40 - 10)");

  r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: 1000 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 0, "HP clamps at 0, not negative");
  assert(r.includes("DEAD"), "massive damage reports DEAD: " + r);

  // --- death gating: a dead (0 HP) character can't act, can't be targeted, and can't be
  // healed back by ordinary means — only revive_character moves their HP again ---
  r = await runMechanicsAction("skill_check", { player_name: "alice", stat: "str", difficulty: "easy" }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:") && r.includes("down"), "a dead character can't skill_check: " + r);

  r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: -20 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:") && r.includes("revive_character"), "ordinary healing can't revive a dead character: " + r);

  r = await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: 5 }, { channelId: CHANNEL });
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 0, "further damage on an already-dead character is a no-op");

  await runMechanicsAction("spawn_monster", { name: "TestGoblin", max_hp: 10 }, { channelId: CHANNEL });
  r = await runMechanicsAction("monster_attack", { monster_name: "TestGoblin", target_player_name: "alice", defense_stat: "con" }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "a dead character can't be targeted by monster_attack: " + r);

  // --- revive_character: free resurrection magic (cost 0) ---
  r = await runMechanicsAction("revive_character", { player_name: "alice", hp_restored: 20, cost: 0 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:") && r.includes("no cost"), "free resurrection magic revives with no gold cost: " + r);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 20, "revived at the given hp_restored amount");

  r = await runMechanicsAction("revive_character", { player_name: "alice", hp_restored: 10, cost: 0 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:") && r.includes("still alive"), "reviving an already-alive character errors: " + r);

  // --- revive_character: paid temple service (cost > 0) ---
  await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: 1000 }, { channelId: CHANNEL });
  r = await runMechanicsAction("revive_character", { player_name: "alice", hp_restored: 40, cost: 100000 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:") && r.includes("afford"), "revival fee the payer can't afford errors: " + r);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 0, "still dead after a failed paid revival");

  r = await runMechanicsAction("revive_character", { player_name: "alice", hp_restored: 40, cost: 20 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "paid temple revival succeeds when affordable: " + r);
  c = getCharacter(CHANNEL, "alice");
  assertEqual(c.currentHp, 40, "revived to full HP by the paid service");
  let sheetAfterPaidRevive = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheetAfterPaidRevive.gold, TEST_STARTER_GOLD - 20, "revival fee deducted from the revived character's own gold by default");

  // --- revive_character: payer_name lets a party member cover the fee instead ---
  await createCharacter(CHANNEL, "bob", "uid-bob", { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 25 }, "Bob", "Cleric", null);
  await runMechanicsAction("modify_wallet", { player_name: "bob", amount: 50 }, { channelId: CHANNEL });
  await runMechanicsAction("apply_damage", { target_type: "player", target_name: "alice", amount: 1000 }, { channelId: CHANNEL });
  r = await runMechanicsAction("revive_character", { player_name: "alice", hp_restored: 15, cost: 30, payer_name: "bob" }, { channelId: CHANNEL });
  assert(r.startsWith("OK:") && r.includes("bob paid 30 gold"), "payer_name lets another character cover the revival fee: " + r);
  const bobSheet = getCharacterSheet(CHANNEL, "bob");
  assertEqual(bobSheet.gold, 70, "payer's own gold is deducted (50 starting + 50 - 30)");
  const aliceSheetAfterPayerRevive = getCharacterSheet(CHANNEL, "alice");
  assertEqual(aliceSheetAfterPayerRevive.gold, sheetAfterPaidRevive.gold, "revived character's own gold untouched when payer_name covers the fee");

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
  assertEqual(c.maxHp, 45, "maxHp +5 on level up");
  assertEqual(c.currentHp, 45, "currentHp fully restored on level up");
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
  // Alice's gold is 30 here, not the 50 she started with — the paid temple revival tested
  // above spent 20 of it (the payer_name revival test that followed paid from bob's gold, not
  // hers, so it didn't touch this balance further).
  let sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, TEST_STARTER_GOLD - 20, "gold after the earlier paid revival (50 - 20)");

  r = await runMechanicsAction("modify_wallet", { player_name: "alice", amount: 25 }, { channelId: CHANNEL });
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 55, "gold after +25 (30 + 25)");

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
  // Alice is a Warrior, so createCharacter already granted her a starting Sword (qty 1) —
  // buy/sell quantities below are relative to that baseline, not zero.
  await runMechanicsAction("modify_wallet", { player_name: "alice", amount: 100 }, { channelId: CHANNEL });
  r = await runMechanicsAction("buy_item", { player_name: "alice", item_name: "Sword", price: 30, quantity: 2 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "buy_item succeeds when affordable: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 40, "gold deducted correctly on buy (100 - 60)");
  assertEqual(sheet.inventory.find((i) => i.item === "Sword")?.quantity, 3, "bought item added to starting inventory (1 starter + 2 bought)");

  r = await runMechanicsAction("buy_item", { player_name: "alice", item_name: "Castle", price: 10000, quantity: 1 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "buy_item rejects an unaffordable purchase: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 40, "gold unchanged after a failed purchase (no partial deduction)");

  r = await runMechanicsAction("sell_item", { player_name: "alice", item_name: "Sword", price: 15, quantity: 1 }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "sell_item succeeds: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.gold, 55, "gold added correctly on sell (40 + 15)");
  assertEqual(sheet.inventory.find((i) => i.item === "Sword")?.quantity, 2, "sold quantity deducted from inventory (3 - 1)");

  r = await runMechanicsAction("sell_item", { player_name: "alice", item_name: "Sword", price: 15, quantity: 5 }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:"), "selling more than you have errors: " + r);

  // --- equipment: starter gear is pre-tagged, item_used applies a weapon bonus only when it
  // fits the stat rolled, armor/shield apply passively in monster_attack ---
  sheet = getCharacterSheet(CHANNEL, "alice");
  const swordEntry = sheet.inventory.find((i) => i.item === "Sword");
  assertEqual(swordEntry.equipType, "weapon", "starter Sword is tagged as a weapon");
  assertEqual(swordEntry.equipTier, "standard", "starter Sword defaults to standard tier");
  assert(swordEntry.equipStats.includes("str") && !swordEntry.equipStats.includes("dex"), "starter Sword suits str, not dex");
  const shieldEntry = sheet.inventory.find((i) => i.item === "Shield");
  assertEqual(shieldEntry.equipType, "shield", "starter Shield is tagged as a shield");

  // Alice's str is STAT_CAP (40, trained earlier) -> stat modifier +8. Standard-tier weapon
  // bonus is +2 — the result string shows both components separately (not pre-summed), so this
  // is deterministic even though the die roll itself is random.
  r = await runMechanicsAction("skill_check", { player_name: "alice", stat: "str", difficulty: "easy", item_used: "Sword" }, { channelId: CHANNEL });
  assert(r.includes("+8 (STR) +2 (Sword)"), "matching weapon bonus shows both the stat and item components separately: " + r);

  r = await runMechanicsAction("skill_check", { player_name: "alice", stat: "dex", difficulty: "easy", item_used: "Sword" }, { channelId: CHANNEL });
  assert(!r.includes("(Sword)"), "weapon bonus does NOT apply when the stat doesn't fit the weapon: " + r);

  r = await runMechanicsAction("skill_check", { player_name: "alice", stat: "str", difficulty: "easy", item_used: "Warhammer of Doom" }, { channelId: CHANNEL });
  assert(r.startsWith("ERROR:") && r.includes("doesn't have"), "item_used naming an unowned item errors (possession check): " + r);

  // Alice's con is untouched at 20 -> defense modifier floor(20/5)=4, base DC 14; her starter
  // Shield (standard tier, +2) should passively raise that to 16 with no tool call needed for it.
  await runMechanicsAction("spawn_monster", { name: "EquipTestMonster", max_hp: 10 }, { channelId: CHANNEL });
  r = await runMechanicsAction("monster_attack", { monster_name: "EquipTestMonster", target_player_name: "alice", defense_stat: "con" }, { channelId: CHANNEL });
  assert(r.includes("DC 16, +2 Shield"), "shield bonus passively raises the defense DC in monster_attack: " + r);

  // add_item/buy_item with explicit equip fields on a brand-new item name.
  r = await runMechanicsAction(
    "add_item",
    { player_name: "alice", item_name: "Frostbrand", equip_type: "weapon", equip_stats: ["str"], equip_tier: "legendary" },
    { channelId: CHANNEL }
  );
  assert(r.startsWith("OK:"), "add_item with equip fields succeeds: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  const frostbrand = sheet.inventory.find((i) => i.item === "Frostbrand");
  assertEqual(frostbrand.equipTier, "legendary", "add_item stores the given equip_tier");
  r = await runMechanicsAction("skill_check", { player_name: "alice", stat: "str", difficulty: "easy", item_used: "Frostbrand" }, { channelId: CHANNEL });
  assert(r.includes("+8 (STR) +4 (Frostbrand)"), "legendary tier grants +4 instead of the standard +2: " + r);

  // Invalid equip_type is silently dropped rather than erroring the whole grant.
  r = await runMechanicsAction("add_item", { player_name: "alice", item_name: "Plain Rock", equip_type: "not_a_real_type" }, { channelId: CHANNEL });
  assert(r.startsWith("OK:"), "an invalid equip_type doesn't block the item grant: " + r);
  sheet = getCharacterSheet(CHANNEL, "alice");
  assertEqual(sheet.inventory.find((i) => i.item === "Plain Rock").equipType, undefined, "invalid equip_type is dropped, item stored as ordinary");

  // Stacking more of an already-owned equipped item doesn't overwrite its existing equip fields.
  r = await runMechanicsAction(
    "add_item",
    { player_name: "alice", item_name: "Sword", quantity: 1, equip_type: "weapon", equip_stats: ["dex"], equip_tier: "legendary" },
    { channelId: CHANNEL }
  );
  sheet = getCharacterSheet(CHANNEL, "alice");
  const swordAfterRestack = sheet.inventory.find((i) => i.item === "Sword");
  assertEqual(swordAfterRestack.equipTier, "standard", "restacking an existing item does not overwrite its original equip fields");
  assertEqual(swordAfterRestack.quantity, 3, "restacking still adds quantity normally (2 + 1)");

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
  const successCountMatch = r.match(/(\d+)\/(\d+) succeeded/);
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
