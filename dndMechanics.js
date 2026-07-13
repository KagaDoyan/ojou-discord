// dndMechanics.js
// Character sheets, inventory, wallet, and monster HP tracking for D&D sessions — all
// deterministic local JS. Gemini (via dnd.js's runDndAction) only ever calls these tools and
// gets back a plain-text result; it never does the arithmetic or remembers numbers itself.
// State is scoped to a channel's active session (see clearMechanicsState, called from
// dnd.js's endDndSession) and keyed within that by Discord username — usernames are globally
// unique on Discord, so no separate ID-lookup layer is needed.

import { createJsonStore } from "./jsonStore.js";

const characters = createJsonStore("character.json"); // channelId -> { username -> Character }
const inventories = createJsonStore("inventory.json"); // channelId -> { username -> [{item, quantity}] }
const wallets = createJsonStore("wallet.json"); // channelId -> { username -> gold }
const monsters = createJsonStore("monster.json"); // channelId -> { name -> {maxHp, currentHp} }

const STARTING_GOLD = 50;
const VALID_STATS = ["str", "dex", "con", "int", "wis", "cha"];
const MAX_REQUIRED_SUCCESSES = 5;
// Hard ceiling on any single stat, enforced both at character creation (index.js) and by
// trainStat below — permanent, not just a starting-point limit. Keeps skill_check's modifier
// (floor(stat/5)) capped at +8, so even a maxed specialist never trivializes a very_hard (DC
// 20) check outright — see the balance discussion this came out of.
export const STAT_CAP = 40;

// Class is player-chosen free text (any fantasy/sci-fi flavor they want — "Void Alchemist",
// "Cyber Ronin", whatever), so there's no fixed lookup table to gate it against. The guard
// against a class doing something wildly outside its concept isn't code-enforced by class
// name; it's Gemini's own judgment, expressed through skill_check's difficulty and
// required_successes arguments (harder DC / more rolls needed for a stretch) — or by simply
// not calling the tool at all and narrating a refusal when something's flatly absurd for the
// character. See the CLASS GUARD instructions in persona.js.

// Deterministic starter-kit lookup, keyed by keyword match against the free-text class. Class
// has no fixed rulebook (see the CLASS GUARD note above), so this is intentionally loose —
// a handful of common archetypes get flavorful gear, anything else (including sci-fi concepts
// that don't match a fantasy keyword) falls back to a generic kit. This exists so every
// character has usable starting gear the instant /create_character runs, rather than waiting on
// the DM to narrate it in — see STARTER_KIT_FALLBACK for the always-present baseline.
// Equipment mechanics: a weapon/armor/shield can carry a real mechanical bonus, but WHICH type
// an item is and how strong it is is never guessed from its name in code — item names are
// freeform (Gemini or a player might call something "Frostbrand" or "Void Ripper"), so a
// keyword list would silently miss most of them. Instead the classification is supplied
// explicitly wherever an item enters inventory — starterKitFor below (fixed, code-authored
// content, not guessed) and add_item/buy_item's optional equip_type/equip_stats/equip_tier args
// (Gemini's own judgment, same pattern as spawn_monster's max_hp or skill_check's difficulty) —
// and stored right on the inventory entry, read back later with no re-guessing involved. See
// EQUIPMENT_TIER_BONUS for the tier -> numeric bonus mapping, and its two consumers: skillCheck
// (weapon bonus, opt-in per action via item_used) and gearDefenseBonus/monsterAttack
// (armor/shield bonus, passive and always-on since defense isn't a per-action choice).
const EQUIPMENT_TIER_BONUS = { standard: 2, fine: 3, legendary: 4 };
const DEFAULT_EQUIPMENT_TIER = "standard";
const EQUIPMENT_TYPES = ["weapon", "armor", "shield"];

function equipmentBonusFor(tier) {
  return EQUIPMENT_TIER_BONUS[tier] || EQUIPMENT_TIER_BONUS[DEFAULT_EQUIPMENT_TIER];
}

// Normalizes add_item/buy_item's optional equip_type/equip_stats/equip_tier args into the
// fields stored on a new inventory entry — silently drops anything invalid (unrecognized type,
// bad tier, stats not in VALID_STATS) rather than erroring, since equipment is an enhancement on
// top of a normal item grant, not something that should block the grant itself. Returns {} for
// a non-equipment item (equip_type omitted), so spreading it onto the stored entry is a no-op.
function buildEquipFields(equipType, equipStats, equipTier) {
  if (!EQUIPMENT_TYPES.includes(equipType)) return {};
  const tier = EQUIPMENT_TIER_BONUS[equipTier] ? equipTier : DEFAULT_EQUIPMENT_TIER;
  const stats = Array.isArray(equipStats) ? equipStats.filter((s) => VALID_STATS.includes(s)) : [];
  return { equipType, equipStats: stats, equipTier: tier };
}

const STARTER_KITS = [
  {
    keywords: ["warrior", "knight", "fighter", "paladin", "barbarian", "soldier", "guard"],
    items: [
      { name: "Sword", equipType: "weapon", equipStats: ["str"] },
      { name: "Shield", equipType: "shield" },
    ],
  },
  {
    keywords: ["rogue", "thief", "assassin", "bandit"],
    items: [
      { name: "Dagger", equipType: "weapon", equipStats: ["str", "dex"] },
      { name: "Lockpick Set" },
    ],
  },
  {
    keywords: ["mage", "wizard", "sorcerer", "witch", "warlock"],
    items: [
      { name: "Wand", equipType: "weapon", equipStats: ["int", "wis", "cha"] },
      { name: "Spellbook" },
    ],
  },
  {
    keywords: ["archer", "ranger", "hunter"],
    items: [
      { name: "Shortbow", equipType: "weapon", equipStats: ["dex"] },
      { name: "Quiver of Arrows" },
    ],
  },
  {
    keywords: ["healer", "cleric", "priest", "monk"],
    items: [
      { name: "Healing Herbs" },
      { name: "Holy Symbol", equipType: "weapon", equipStats: ["int", "wis", "cha"] },
    ],
  },
  {
    keywords: ["bard", "singer", "performer"],
    items: [
      { name: "Lute", equipType: "weapon", equipStats: ["cha"] },
      { name: "Dagger", equipType: "weapon", equipStats: ["str", "dex"] },
    ],
  },
  {
    keywords: ["hacker", "engineer", "technician", "mechanic"],
    items: [{ name: "Multitool" }, { name: "Datapad" }],
  },
  {
    keywords: ["pilot", "trooper", "marine", "cyber", "gunner"],
    items: [
      { name: "Blaster Pistol", equipType: "weapon", equipStats: ["dex"] },
      { name: "Combat Vest", equipType: "armor" },
    ],
  },
];
const STARTER_KIT_FALLBACK = [{ name: "Traveler's Pack" }, { name: "Torch" }];

// Turns a STARTER_KITS entry into real inventory rows (item/quantity/equip fields), ready to
// store directly — starter gear is always DEFAULT_EQUIPMENT_TIER ("standard"), better gear is
// something a character finds/buys/is granted later via add_item/buy_item's equip_tier arg.
function starterKitFor(characterClass) {
  const lower = (characterClass || "").toLowerCase();
  const matched = STARTER_KITS.find((kit) => kit.keywords.some((word) => lower.includes(word)));
  const picks = [...(matched ? matched.items : STARTER_KIT_FALLBACK), { name: "Rations" }];
  return picks.map(({ name, equipType, equipStats }) => ({
    item: name,
    quantity: 1,
    ...(equipType ? { equipType, equipStats: equipStats || [], equipTier: DEFAULT_EQUIPMENT_TIER } : {}),
  }));
}

// Best armor bonus + best shield bonus currently in a character's inventory (each slot counted
// once — carrying two shields doesn't stack, but armor and a shield are separate slots and both
// apply). Used by monsterAttack to passively raise the defense DC; no tool call needed for this,
// unlike a weapon's item_used opt-in, since what you're wearing isn't a per-action choice.
function gearDefenseBonus(items) {
  let armorBonus = 0;
  let armorName = null;
  let shieldBonus = 0;
  let shieldName = null;
  for (const it of items) {
    if (!it.equipType) continue;
    const bonus = equipmentBonusFor(it.equipTier);
    if (it.equipType === "armor" && bonus > armorBonus) {
      armorBonus = bonus;
      armorName = it.item;
    }
    if (it.equipType === "shield" && bonus > shieldBonus) {
      shieldBonus = bonus;
      shieldName = it.item;
    }
  }
  const parts = [];
  if (armorName) parts.push(`+${armorBonus} ${armorName}`);
  if (shieldName) parts.push(`+${shieldBonus} ${shieldName}`);
  return { bonus: armorBonus + shieldBonus, label: parts.length ? `, ${parts.join(" + ")}` : "" };
}

export async function loadMechanicsState() {
  await Promise.all([characters.load(), inventories.load(), wallets.load(), monsters.load()]);
}

export async function clearMechanicsState(channelId) {
  characters.data.delete(channelId);
  inventories.data.delete(channelId);
  wallets.data.delete(channelId);
  monsters.data.delete(channelId);
  await Promise.all([
    characters.scheduleSave(),
    inventories.scheduleSave(),
    wallets.scheduleSave(),
    monsters.scheduleSave(),
  ]);
}

function getChannelBucket(store, channelId) {
  let bucket = store.data.get(channelId);
  if (!bucket) {
    bucket = {};
    store.data.set(channelId, bucket);
  }
  return bucket;
}

// Resolves a possibly-mistyped-case name (from Gemini's tool call args) against the keys
// actually stored for this channel — usernames are stored with their canonical Discord
// casing, but Gemini may echo a different case back in a tool call.
function findKey(bucket, name) {
  if (!name) return null;
  if (Object.prototype.hasOwnProperty.call(bucket, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(bucket).find((key) => key.toLowerCase() === lower) ?? null;
}

// Gemini sometimes passes a character's flavor `name` (or the whole "username (aka name)"
// label shown in CURRENT STATE) instead of the bare Discord username these tools are actually
// keyed by — e.g. calling player_name with the character's fantasy name instead of their real
// username. Falls back through: exact/case-insensitive username match (findKey, the normal
// case) -> case-insensitive match against each character's flavor name -> extracting a
// username from a trailing "(...)" in case the whole label got echoed back. Used everywhere a
// Gemini tool call resolves a player, so this specific confusion self-corrects instead of
// erroring every time.
function findCharacterKey(charBucket, playerName) {
  const direct = findKey(charBucket, playerName);
  if (direct) return direct;
  if (!playerName) return null;

  const lower = playerName.toLowerCase();
  for (const [key, character] of Object.entries(charBucket)) {
    if (character.name && character.name.toLowerCase() === lower) return key;
  }

  const parenMatch = playerName.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) return findKey(charBucket, parenMatch[1].trim());

  return null;
}

export function hasCharacter(channelId, username) {
  const bucket = characters.data.get(channelId);
  return bucket ? findKey(bucket, username) !== null : false;
}

export function getCharacter(channelId, username) {
  const bucket = characters.data.get(channelId);
  if (!bucket) return undefined;
  const key = findKey(bucket, username);
  return key ? bucket[key] : undefined;
}

// Bundles a character with its inventory/gold (separate stores) for display purposes — e.g.
// the /dnd stat embed in index.js. Returns null if no character exists for that username.
export function getCharacterSheet(channelId, username) {
  const charBucket = characters.data.get(channelId) || {};
  const key = findKey(charBucket, username);
  if (!key) return null;
  const invBucket = inventories.data.get(channelId) || {};
  const walletBucket = wallets.data.get(channelId) || {};
  return {
    username: key,
    character: charBucket[key],
    inventory: invBucket[key] || [],
    gold: walletBucket[key] ?? 0,
  };
}

export async function createCharacter(
  channelId,
  username,
  userId,
  stats,
  name = null,
  characterClass = "Adventurer",
  background = null
) {
  const con = Number(stats.con) || 0;
  // Base bumped from 10 to 20 (see the HP-balance discussion this came out of) — 10+con let a
  // low-con build start as low as 10 HP, which combined with freeform monster damage made a
  // two-hit kill in the very first encounter routine instead of a rare bad-luck outcome.
  const maxHp = 20 + con;
  const charBucket = getChannelBucket(characters, channelId);
  charBucket[username] = {
    name,
    userId,
    class: (characterClass || "Adventurer").trim().slice(0, 50),
    background: background ? background.trim().slice(0, 300) : null,
    stats: {
      str: Number(stats.str) || 0,
      dex: Number(stats.dex) || 0,
      con,
      int: Number(stats.int) || 0,
      wis: Number(stats.wis) || 0,
      cha: Number(stats.cha) || 0,
    },
    level: 1,
    exp: 0,
    unspentStatPoints: 0,
    maxHp,
    currentHp: maxHp,
  };
  const starterKit = starterKitFor(characterClass);
  getChannelBucket(inventories, channelId)[username] = starterKit;
  getChannelBucket(wallets, channelId)[username] = STARTING_GOLD;

  await Promise.all([characters.scheduleSave(), inventories.scheduleSave(), wallets.scheduleSave()]);
  return { ...charBucket[username], starterItems: starterKit.map((i) => i.item) };
}

// Shared by buildPartyStatusText below and the /dnd stat embed (index.js) so both surfaces show
// an equipped item's bonus without either one re-deriving it — the DM sees at a glance which
// carried items are actually worth passing to skill_check's item_used, instead of needing to
// remember what was granted with what equip_type/equip_tier turns ago.
export function formatItemLabel(item) {
  const base = `${item.item} x${item.quantity}`;
  if (!item.equipType) return base;
  const bonus = equipmentBonusFor(item.equipTier);
  const statsPart = item.equipType === "weapon" && item.equipStats?.length ? `: ${item.equipStats.join("/")}` : "";
  return `${base} [${item.equipType}${statsPart}, ${item.equipTier}, +${bonus}]`;
}

// Formats current party + monster state as plain text, injected into the D&D system prompt
// every turn (see askAyameDnd in index.js) so Gemini always reasons from real numbers
// without spending a tool-call round-trip on reads.
export function buildPartyStatusText(channelId) {
  const chars = characters.data.get(channelId) || {};
  const inv = inventories.data.get(channelId) || {};
  const wallet = wallets.data.get(channelId) || {};
  const mons = monsters.data.get(channelId) || {};

  const partyLines = Object.entries(chars).map(([username, c]) => {
    const items = (inv[username] || []).map(formatItemLabel).join(", ") || "empty";
    const gold = wallet[username] ?? 0;
    // Username leads and is the ONLY thing tool calls should ever use to identify this
    // player — the flavor name is marked "aka" specifically so it reads as secondary, not
    // the primary identifier (Gemini has previously echoed the flavor name back into
    // player_name/target_name args, which fails to resolve).
    const label = c.name ? `${username} (aka "${c.name}")` : username;
    return (
      `${label} [${c.class}] — Lvl ${c.level}, HP ${c.currentHp}/${c.maxHp}${c.currentHp <= 0 ? " (DEAD — needs revive_character)" : ""}, EXP ${c.exp}/${c.level * 100}, ` +
      `STR ${c.stats.str}/DEX ${c.stats.dex}/CON ${c.stats.con}/INT ${c.stats.int}/WIS ${c.stats.wis}/CHA ${c.stats.cha}, ` +
      `Gold ${gold}, Inventory: ${items}` +
      (c.background ? `, Background: ${c.background}` : "") +
      (c.unspentStatPoints ? `, Unspent stat points: ${c.unspentStatPoints} (use /dnd train)` : "")
    );
  });

  const monsterLines = Object.entries(mons).map(
    ([name, m]) => `${name} — HP ${m.currentHp}/${m.maxHp}${m.currentHp <= 0 ? " (defeated)" : ""}`
  );

  return [
    partyLines.length ? `PARTY:\n${partyLines.join("\n")}` : "PARTY: (no characters created yet)",
    monsterLines.length ? `MONSTERS:\n${monsterLines.join("\n")}` : "MONSTERS: (none currently)",
  ].join("\n\n");
}

async function spawnMonster(channelId, name, maxHp) {
  maxHp = Number(maxHp);
  if (!name || !Number.isFinite(maxHp) || maxHp <= 0) {
    return "ERROR: spawn_monster needs a name and a positive max_hp.";
  }
  const bucket = getChannelBucket(monsters, channelId);
  bucket[name] = { maxHp, currentHp: maxHp };
  await monsters.scheduleSave();
  return `OK: ${name} spawned with ${maxHp} HP.`;
}

const DIFFICULTY_DC = { easy: 8, medium: 12, hard: 16, very_hard: 20 };

function rollD20WithModifier(modifier, dc) {
  const roll = Math.floor(Math.random() * 20) + 1;
  const total = roll + modifier;

  let success;
  let flavor = "";
  if (roll === 20) {
    success = true;
    flavor = " (Natural 20 — critical success!)";
  } else if (roll === 1) {
    success = false;
    flavor = " (Natural 1 — critical failure!)";
  } else {
    success = total >= dc;
  }

  const modifierText = modifier >= 0 ? `+${modifier}` : `${modifier}`;
  return { roll, total, success, flavor, modifierText };
}

// The single entry point for ANY stat-tied uncertain action — attacks, forcing something
// open, searching, sneaking, persuasion, spellcasting, whatever the free-text class's fantasy
// allows. The roll modifier always comes from the character's real stored stat, never from
// Gemini's judgment — but there's no fixed class table to gate against here, so class-fit
// itself is entirely Gemini's judgment call, expressed through the arguments it picks: a
// bigger stretch for the character's concept should mean a harder `difficulty` and/or a
// higher `required_successes` (every one of that many separate rolls must succeed), while
// something flatly impossible for the character should just never reach this tool at all —
// Gemini narrates a refusal in prose instead. A natural 20/1 always succeeds/fails that
// individual roll outright regardless of DC (a deliberate simplification over strict 5e
// rules, fitting a light one-shot feel).
async function skillCheck(channelId, playerName, stat, difficulty, requiredSuccesses, itemUsed) {
  if (!VALID_STATS.includes(stat)) return `ERROR: stat must be one of ${VALID_STATS.join(", ")}.`;
  if (!DIFFICULTY_DC[difficulty]) return `ERROR: difficulty must be one of ${Object.keys(DIFFICULTY_DC).join(", ")}.`;

  const count = Math.min(Math.max(parseInt(requiredSuccesses, 10) || 1, 1), MAX_REQUIRED_SUCCESSES);
  const dc = DIFFICULTY_DC[difficulty];

  const bucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(bucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;

  const character = bucket[key];
  if (character.currentHp <= 0) {
    return `ERROR: ${key} is down (0 HP) and can't act until revived — see revive_character.`;
  }

  // item_used is optional — only present when the DM says this action is specifically wielding
  // a carried item. Doubles as a code-enforced possession check (errors if they don't actually
  // have it), and only adds a bonus if that item was stored as a weapon fit for this stat (see
  // equip_type/equip_stats on add_item/buy_item, or starterKitFor for starting gear) — naming a
  // non-weapon item (a torch, a lockpick set) is valid and doesn't error, it just adds no bonus.
  let itemBonus = 0;
  let itemName = null;
  if (itemUsed) {
    const invBucket = inventories.data.get(channelId) || {};
    const owned = (invBucket[key] || []).find((i) => i.item.toLowerCase() === itemUsed.toLowerCase());
    if (!owned) return `ERROR: ${key} doesn't have "${itemUsed}" — can't use it for this check.`;
    if (owned.equipType === "weapon" && (owned.equipStats || []).includes(stat)) {
      itemBonus = equipmentBonusFor(owned.equipTier);
      itemName = owned.item;
    }
  }

  // Kept separate from itemBonus (rather than pre-summed) purely so the result string below can
  // show each contributing piece on its own — stat bonus and item bonus read as one opaque
  // number otherwise, which is the exact confusion this format replaced (see the readability
  // discussion this came out of: a player couldn't tell how much of a roll's modifier was their
  // stat vs. their weapon).
  const statModifier = Math.floor(character.stats[stat] / 5);
  const modifier = statModifier + itemBonus;

  const rolls = [];
  let allSucceeded = true;
  for (let i = 0; i < count; i++) {
    const outcome = rollD20WithModifier(modifier, dc);
    rolls.push(outcome);
    if (!outcome.success) allSucceeded = false;
  }
  const successCount = rolls.filter((r) => r.success).length;

  const statLabel = stat.toUpperCase();
  const statPart = `${statModifier >= 0 ? "+" : ""}${statModifier} (${statLabel})`;
  const itemPart = itemBonus ? ` +${itemBonus} (${itemName})` : "";
  const rollBreakdowns = rolls.map((r) => `${r.roll} ${statPart}${itemPart} = ${r.total}${r.success ? " ✓" : " ✗"}${r.flavor}`);

  const needText = `need ${dc} to succeed${count > 1 ? ` (all ${count} rolls must succeed)` : ""}`;
  const rolledText = count > 1 ? `rolled: ${rollBreakdowns.join("; ")}` : `rolled ${rollBreakdowns[0]}`;

  return (
    `OK: ${key}'s ${statLabel} check — ${needText} — ${rolledText} — ` +
    `${count > 1 ? `${successCount}/${count} succeeded — ` : ""}${allSucceeded ? "SUCCESS" : "FAILURE"}.`
  );
}

async function applyDamage(channelId, targetType, targetName, amount, reason) {
  amount = Number(amount);
  if (!Number.isFinite(amount)) return "ERROR: apply_damage needs a numeric amount.";

  const verb = amount >= 0 ? "takes" : "recovers";
  const noun = amount >= 0 ? "damage" : "HP";
  const magnitude = Math.abs(amount);

  if (targetType === "monster") {
    const bucket = getChannelBucket(monsters, channelId);
    const key = findKey(bucket, targetName);
    if (!key) return `ERROR: no monster named "${targetName}" has been spawned yet — call spawn_monster first.`;
    const monster = bucket[key];
    monster.currentHp = Math.min(monster.maxHp, Math.max(0, monster.currentHp - amount));
    await monsters.scheduleSave();
    const defeated = monster.currentHp <= 0;
    return `OK: ${key} ${verb} ${magnitude} ${noun} (${monster.currentHp}/${monster.maxHp} HP)${defeated ? " — defeated!" : ""}.`;
  }

  if (targetType === "player") {
    const bucket = getChannelBucket(characters, channelId);
    const key = findCharacterKey(bucket, targetName);
    if (!key) return `ERROR: no character found for "${targetName}".`;
    const character = bucket[key];

    // A character already at 0 HP is dead, not just hurt — ordinary damage/healing no longer
    // moves their HP. More damage is a no-op (nothing left to lose), and healing must go
    // through revive_character instead (magic resurrection or a paid temple service), so death
    // stays a real, deliberate beat rather than something a routine heal quietly undoes.
    if (character.currentHp <= 0) {
      if (amount <= 0) {
        return `ERROR: ${key} is dead (0 HP) — ordinary healing can't bring them back. Use revive_character (resurrection magic, or a temple's paid service) instead.`;
      }
      return `OK: ${key} is already down (0 HP) — unaffected by further damage.`;
    }

    character.currentHp = Math.min(character.maxHp, Math.max(0, character.currentHp - amount));
    await characters.scheduleSave();
    const downed = character.currentHp <= 0;
    return `OK: ${key} ${verb} ${magnitude} ${noun} (${character.currentHp}/${character.maxHp} HP)${downed ? " — DEAD (0 HP)! Out of action until revived — see revive_character." : ""}.`;
  }

  return 'ERROR: target_type must be "monster" or "player".';
}

// Resolves a monster's own attack against a player — the DM rolling on the monster's behalf,
// separate from the player's own skill_check. Deliberately hit/miss only: on a HIT, Gemini
// still decides the damage amount and calls apply_damage separately, same as it already does
// for the player's own attacks against monsters — keeps "how much damage" a single consistent
// judgment call everywhere instead of a different rule for each direction of combat.
async function monsterAttack(channelId, monsterName, targetPlayerName, defenseStat) {
  if (!VALID_STATS.includes(defenseStat)) return `ERROR: defense_stat must be one of ${VALID_STATS.join(", ")}.`;

  const monsterBucket = monsters.data.get(channelId) || {};
  const monsterKey = findKey(monsterBucket, monsterName);
  if (!monsterKey) return `ERROR: no monster named "${monsterName}" has been spawned yet — call spawn_monster first.`;
  const monster = monsterBucket[monsterKey];
  if (monster.currentHp <= 0) return `ERROR: ${monsterKey} has already been defeated and can't attack.`;

  const charBucket = characters.data.get(channelId) || {};
  const targetKey = findCharacterKey(charBucket, targetPlayerName);
  if (!targetKey) return `ERROR: no character found for "${targetPlayerName}".`;
  const target = charBucket[targetKey];
  if (target.currentHp <= 0) return `ERROR: ${targetKey} is already down (0 HP) — pick a different target.`;

  // Attack bonus ties directly to the toughness (maxHp) Gemini already judged at spawn_monster
  // time — no separate field for her to independently decide and risk being inconsistent
  // about. Defense DC comes from the target's real stored stat plus any armor/shield currently
  // in their inventory (gearDefenseBonus — passive, no tool call needed for it), same modifier
  // scale as skill_check — deterministic on both sides of the roll.
  const attackBonus = Math.floor(monster.maxHp / 5);
  const invBucket = inventories.data.get(channelId) || {};
  const defenseGear = gearDefenseBonus(invBucket[targetKey] || []);
  const dc = 10 + Math.floor(target.stats[defenseStat] / 5) + defenseGear.bonus;
  const { roll, total, success, flavor, modifierText } = rollD20WithModifier(attackBonus, dc);

  return (
    `OK: ${monsterKey} attacks ${targetKey} (${defenseStat.toUpperCase()} defense, DC ${dc}${defenseGear.label}) — ` +
    `rolled ${roll}${modifierText} = ${total} — ${success ? "HIT" : "MISS"}${flavor}.`
  );
}

// Brings a dead (0 HP) character back — the only way their HP moves again once they hit 0 (see
// the dead-state gating in applyDamage/skillCheck/monsterAttack above). Covers both revival
// paths from the DEATH & REVIVAL persona instructions: a party spellcaster's resurrection magic
// (cost 0, called after their own successful skill_check) or a temple/priest's paid service back
// in town (cost > 0). The third path — retiring the character and building a new one via
// /create_character instead — never touches this tool at all.
// payer_name lets a party member other than the revived character foot the bill (covering a
// dead ally's temple fee out of their own pocket); defaults to the revived character's own gold.
async function reviveCharacter(channelId, playerName, hpRestored, cost, payerName) {
  hpRestored = Number(hpRestored);
  cost = Number(cost) || 0;
  if (!Number.isFinite(hpRestored) || hpRestored <= 0) return "ERROR: revive_character needs a positive hp_restored.";
  if (cost < 0) return "ERROR: cost can't be negative.";

  const charBucket = getChannelBucket(characters, channelId);
  const key = findCharacterKey(charBucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const character = charBucket[key];
  if (character.currentHp > 0) {
    return `ERROR: ${key} is still alive (${character.currentHp}/${character.maxHp} HP) — no revival needed.`;
  }

  const walletBucket = getChannelBucket(wallets, channelId);
  let payerKey = key;
  if (cost > 0) {
    if (payerName) {
      const resolvedPayer = findCharacterKey(charBucket, payerName);
      if (!resolvedPayer) return `ERROR: no character found for payer "${payerName}".`;
      payerKey = resolvedPayer;
    }
    const balance = walletBucket[payerKey] ?? 0;
    if (balance < cost) return `ERROR: ${payerKey} can't afford the ${cost} gold revival fee (has ${balance}).`;
    walletBucket[payerKey] = balance - cost;
  }

  character.currentHp = Math.min(character.maxHp, hpRestored);
  await Promise.all([characters.scheduleSave(), wallets.scheduleSave()]);
  return (
    `OK: ${key} is revived with ${character.currentHp}/${character.maxHp} HP` +
    (cost > 0 ? ` (${payerKey} paid ${cost} gold)` : " (no cost)") +
    "."
  );
}

async function addExp(channelId, playerName, amount) {
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount < 0) return "ERROR: add_exp needs a non-negative numeric amount.";
  const bucket = getChannelBucket(characters, channelId);
  const key = findCharacterKey(bucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const character = bucket[key];
  character.exp += amount;

  let leveledUp = false;
  while (character.exp >= character.level * 100) {
    character.exp -= character.level * 100;
    character.level += 1;
    character.maxHp += 5;
    character.currentHp = character.maxHp;
    character.unspentStatPoints = (character.unspentStatPoints || 0) + 1;
    leveledUp = true;
  }

  await characters.scheduleSave();
  return (
    `OK: ${key} gains ${amount} EXP (Lvl ${character.level}, ${character.exp}/${character.level * 100} EXP)` +
    `${leveledUp ? ` — LEVEL UP! (+1 stat point to spend via /dnd train, now has ${character.unspentStatPoints})` : ""}.`
  );
}

async function modifyCharacterStat(channelId, playerName, stat, delta) {
  delta = Number(delta);
  if (!VALID_STATS.includes(stat)) return `ERROR: stat must be one of ${VALID_STATS.join(", ")}.`;
  if (!Number.isFinite(delta)) return "ERROR: modify_character_stat needs a numeric delta.";
  const bucket = getChannelBucket(characters, channelId);
  const key = findCharacterKey(bucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const character = bucket[key];
  character.stats[stat] = Math.max(0, character.stats[stat] + delta);
  await characters.scheduleSave();
  return `OK: ${key}'s ${stat.toUpperCase()} is now ${character.stats[stat]}.`;
}

// Player-driven, not a Gemini tool — called directly from the /dnd train slash command
// (index.js), never through runMechanicsAction. Spends an unspent level-up stat point (see
// addExp above, +1 per level) on one of the six stats, permanently capped at STAT_CAP just
// like creation-time allocation, so the balance math stays true for the whole session.
export async function trainStat(channelId, playerName, stat, points) {
  points = Number(points);
  if (!VALID_STATS.includes(stat)) return `ERROR: stat must be one of ${VALID_STATS.join(", ")}.`;
  if (!Number.isInteger(points) || points < 1) return "ERROR: points must be a positive whole number.";

  const bucket = characters.data.get(channelId) || {};
  const key = findKey(bucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const character = bucket[key];

  const available = character.unspentStatPoints || 0;
  if (points > available) {
    return `ERROR: ${key} only has ${available} unspent stat point${available === 1 ? "" : "s"} to spend.`;
  }

  const newValue = character.stats[stat] + points;
  if (newValue > STAT_CAP) {
    const maxSpendable = STAT_CAP - character.stats[stat];
    return maxSpendable > 0
      ? `ERROR: that would push ${stat.toUpperCase()} to ${newValue}, past the ${STAT_CAP} cap — ${key} can add at most ${maxSpendable} more right now.`
      : `ERROR: ${stat.toUpperCase()} is already at the ${STAT_CAP} cap for ${key}.`;
  }

  character.stats[stat] = newValue;
  character.unspentStatPoints = available - points;
  await characters.scheduleSave();
  return (
    `OK: ${key}'s ${stat.toUpperCase()} is now ${newValue} (spent ${points} point${points === 1 ? "" : "s"}, ` +
    `${character.unspentStatPoints} remaining).`
  );
}

async function modifyWallet(channelId, playerName, amount) {
  amount = Number(amount);
  if (!Number.isFinite(amount)) return "ERROR: modify_wallet needs a numeric amount.";
  const charBucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(charBucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const bucket = getChannelBucket(wallets, channelId);
  bucket[key] = Math.max(0, (bucket[key] ?? 0) + amount);
  await wallets.scheduleSave();
  return `OK: ${key}'s gold is now ${bucket[key]} (${amount >= 0 ? "+" : ""}${amount}).`;
}

async function addItem(channelId, playerName, itemName, quantity, equipType, equipStats, equipTier) {
  quantity = Number(quantity) || 1;
  if (!itemName) return "ERROR: add_item needs an item_name.";
  const charBucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(charBucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const invBucket = getChannelBucket(inventories, channelId);
  const items = invBucket[key] || (invBucket[key] = []);
  const existing = items.find((i) => i.item.toLowerCase() === itemName.toLowerCase());
  // Equip fields only apply when the entry is first created — if it's already there, stacking
  // more quantity onto it shouldn't silently change (or clear) whatever equipment data it
  // already has just because this particular call didn't repeat it.
  if (existing) existing.quantity += quantity;
  else items.push({ item: itemName, quantity, ...buildEquipFields(equipType, equipStats, equipTier) });
  await inventories.scheduleSave();
  return `OK: ${key} receives ${quantity}x ${itemName}.`;
}

async function removeItem(channelId, playerName, itemName, quantity) {
  quantity = Number(quantity) || 1;
  const charBucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(charBucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const invBucket = getChannelBucket(inventories, channelId);
  const items = invBucket[key] || [];
  const existing = items.find((i) => i.item.toLowerCase() === (itemName || "").toLowerCase());
  if (!existing || existing.quantity < quantity) {
    return `ERROR: ${key} doesn't have ${quantity}x ${itemName}.`;
  }
  existing.quantity -= quantity;
  if (existing.quantity <= 0) invBucket[key] = items.filter((i) => i !== existing);
  await inventories.scheduleSave();
  return `OK: ${quantity}x ${itemName} removed from ${key}'s inventory.`;
}

async function buyItem(channelId, playerName, itemName, price, quantity, equipType, equipStats, equipTier) {
  quantity = Number(quantity) || 1;
  price = Number(price);
  if (!itemName) return "ERROR: buy_item needs an item_name.";
  if (!Number.isFinite(price) || price < 0) return "ERROR: buy_item needs a non-negative numeric price.";
  const charBucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(charBucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;

  const total = price * quantity;
  const walletBucket = getChannelBucket(wallets, channelId);
  const balance = walletBucket[key] ?? 0;
  if (balance < total) return `ERROR: ${key} can't afford ${quantity}x ${itemName} for ${total} gold (has ${balance}).`;

  walletBucket[key] = balance - total;
  const invBucket = getChannelBucket(inventories, channelId);
  const items = invBucket[key] || (invBucket[key] = []);
  const existing = items.find((i) => i.item.toLowerCase() === itemName.toLowerCase());
  if (existing) existing.quantity += quantity;
  else items.push({ item: itemName, quantity, ...buildEquipFields(equipType, equipStats, equipTier) });

  await Promise.all([wallets.scheduleSave(), inventories.scheduleSave()]);
  return `OK: ${key} buys ${quantity}x ${itemName} for ${total} gold (${walletBucket[key]} gold left).`;
}

async function sellItem(channelId, playerName, itemName, price, quantity) {
  quantity = Number(quantity) || 1;
  price = Number(price);
  if (!itemName) return "ERROR: sell_item needs an item_name.";
  if (!Number.isFinite(price) || price < 0) return "ERROR: sell_item needs a non-negative numeric price.";
  const charBucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(charBucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;

  const invBucket = getChannelBucket(inventories, channelId);
  const items = invBucket[key] || [];
  const existing = items.find((i) => i.item.toLowerCase() === (itemName || "").toLowerCase());
  if (!existing || existing.quantity < quantity) {
    return `ERROR: ${key} doesn't have ${quantity}x ${itemName} to sell.`;
  }
  existing.quantity -= quantity;
  if (existing.quantity <= 0) invBucket[key] = items.filter((i) => i !== existing);

  const total = price * quantity;
  const walletBucket = getChannelBucket(wallets, channelId);
  walletBucket[key] = (walletBucket[key] ?? 0) + total;

  await Promise.all([wallets.scheduleSave(), inventories.scheduleSave()]);
  return `OK: ${key} sells ${quantity}x ${itemName} for ${total} gold (${walletBucket[key]} gold now).`;
}

export const MECHANICS_FUNCTION_DECLARATIONS = [
  {
    name: "skill_check",
    description:
      "Resolve ANY uncertain action where a character's stats should matter — attacks (str " +
      "for melee, dex for ranged/finesse), forcing something open (str), searching/perception " +
      "(wis), sneaking (dex), persuasion (cha), spellcasting (usually int/wis/cha), or " +
      "anything else tied to the character's class/concept. Pick the single most relevant " +
      "stat; never blend multiple stats into one check. Classes are freely player-chosen, so " +
      "there's no fixed rule for what's 'in class' — use your own judgment: if the action is a " +
      "real stretch for this character's concept but still plausible, make it harder by " +
      "raising difficulty and/or required_successes (e.g. 2-3) instead of a normal single " +
      "easy roll; if it's flatly absurd for the character (a baker casting reality-ending " +
      "magic), don't call this tool at all — just narrate a clear, in-character refusal " +
      "explaining why, with no roll. Reserve roll_dice for stat-free flavor rolls only (a " +
      "random encounter, a coin flip). On a successful attack against a monster, decide a " +
      "reasonable damage number and call apply_damage next.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        stat: { type: "string", enum: VALID_STATS, description: "Which stat this check is based on." },
        difficulty: {
          type: "string",
          enum: Object.keys(DIFFICULTY_DC),
          description: "How hard the task is: easy, medium, hard, or very_hard.",
        },
        required_successes: {
          type: "number",
          description:
            "How many separate rolls must ALL succeed (default 1). Raise this (2-5) instead of " +
            "just difficulty when something is a real stretch for the character's class/concept " +
            "but you're still letting them attempt it.",
        },
        item_used: {
          type: "string",
          description:
            "Optional: the exact Inventory item name the character is wielding for THIS action " +
            "(an attack with a weapon, a spellcast with a focus). Verifies they actually have it " +
            "(errors if not, same as any other item-possession check) and automatically adds a " +
            "mechanical bonus if it's a weapon/focus that fits the stat being rolled (a sword " +
            "helps a str attack, a bow helps a dex attack, a wand/holy symbol helps " +
            "int/wis/cha spellcasting). Omit for checks with no specific item involved " +
            "(persuasion, sneaking bare-handed, etc.) — armor/shields never go here, their " +
            "defense bonus applies automatically and passively in monster_attack instead.",
        },
        reason: { type: "string", description: "Brief reason, e.g. 'forcing open the locked chest'." },
      },
      required: ["player_name", "stat", "difficulty"],
    },
  },
  {
    name: "spawn_monster",
    description:
      "Register a new monster/enemy for this encounter with its starting HP, before any " +
      "damage is dealt to it. Call this once when a monster or enemy first appears.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The monster's name, e.g. 'Goblin' or 'Goblin 2' if there are multiple." },
        max_hp: { type: "number", description: "Starting/maximum HP for this monster." },
      },
      required: ["name", "max_hp"],
    },
  },
  {
    name: "apply_damage",
    description:
      "Apply damage (or healing, with a negative amount) to a monster or a player character's " +
      "HP. Always call this before narrating any HP change — never state a damage/heal number " +
      "without calling this first. Damage guidance: 2-6 for a weak/minor enemy, 5-10 for a " +
      "standard enemy, 8-15 for a strong/elite enemy, 12-20+ reserved for a boss/climactic " +
      "threat. Avoid dropping a fresh full-HP character to 0 in one or two hits outside a " +
      "deliberately climactic moment — this matters most in the opening encounter of a session, " +
      "which should be survivable for a fresh level-1 party. Has no effect on a character already " +
      "at 0 HP — see revive_character to bring them back.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["monster", "player"], description: "Whether the target is a monster or a player character." },
        target_name: { type: "string", description: "The monster's name (as given to spawn_monster) or the player's Discord username." },
        amount: { type: "number", description: "Damage to apply (positive) or healing (negative)." },
        reason: { type: "string", description: "Brief reason, e.g. 'sword hit' or 'healing potion'." },
      },
      required: ["target_type", "target_name", "amount"],
    },
  },
  {
    name: "monster_attack",
    description:
      "Resolve a monster's own attack against a player character — you (the DM) rolling on " +
      "the monster's behalf, separate from the player's own skill_check roll. Call this when " +
      "it's a hostile monster's moment to strike back after the player has acted. Pick " +
      "whichever defense_stat best fits this specific attack (dex to dodge, con to " +
      "endure/brace, wis to resist something mental/magical, etc.). On a HIT, decide a " +
      "reasonable damage number and call apply_damage (target_type: player) next — this tool " +
      "only resolves hit or miss, it does not apply damage itself.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        monster_name: { type: "string", description: "The attacking monster's name, as given to spawn_monster." },
        target_player_name: { type: "string", description: "The defending player's Discord username." },
        defense_stat: { type: "string", enum: VALID_STATS, description: "Which of the target's stats determines their defense against this attack." },
        reason: { type: "string", description: "Brief description of the attack, e.g. 'claw swipe' or 'frost curse'." },
      },
      required: ["monster_name", "target_player_name", "defense_stat"],
    },
  },
  {
    name: "revive_character",
    description:
      "Bring a dead (0 HP) character back into play. Only call this once a revival has actually " +
      "been earned in the fiction: a party spellcaster/healer succeeded a skill_check attempting " +
      "resurrection magic (cost 0), or the party paid a temple/priest's service fee back in a " +
      "safe town (cost > 0). Do NOT call this for ordinary in-combat healing on a living " +
      "character — use apply_damage with a negative amount for that instead; this tool only " +
      "works on a character currently at 0 HP. This tool deducts the full cost itself, " +
      "atomically — if a payer was short on gold and you narrate them coming up with the rest " +
      "(selling something, borrowing, etc.), do NOT separately call modify_wallet to pre-pay any " +
      "part of it; once they can cover the full cost, just call revive_character once with the " +
      "complete cost and let it deduct everything in that single call.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The dead (0 HP) player's Discord username." },
        hp_restored: { type: "number", description: "HP to revive them with (positive; clamped to their max HP). A weaker revival might restore only a portion, a stronger one their full max." },
        cost: { type: "number", description: "Gold cost of this revival — 0 for free resurrection magic, positive for a temple's paid service. Defaults to 0." },
        payer_name: { type: "string", description: "Optional: whose gold pays the cost, if not the revived character's own (e.g. a party member covering the fee)." },
      },
      required: ["player_name", "hp_restored"],
    },
  },
  {
    name: "add_exp",
    description:
      "Award experience points to a player character after a meaningful accomplishment (not " +
      "for small talk). Automatically handles leveling up.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        amount: { type: "number", description: "EXP to award (non-negative)." },
        reason: { type: "string", description: "Brief reason, e.g. 'defeated the goblin'." },
      },
      required: ["player_name", "amount"],
    },
  },
  {
    name: "modify_character_stat",
    description:
      "Permanently adjust one of a player character's six base stats (e.g. from a magic item, " +
      "curse, or training). Does not retroactively change max HP.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        stat: { type: "string", enum: VALID_STATS, description: "Which stat to change." },
        delta: { type: "number", description: "Amount to add (or subtract, if negative)." },
        reason: { type: "string", description: "Brief reason for the change." },
      },
      required: ["player_name", "stat", "delta"],
    },
  },
  {
    name: "modify_wallet",
    description:
      "Add or deduct gold outside of a shop transaction — found loot, a fine, gambling " +
      "winnings/losses, etc. For buying/selling from a shop, use buy_item/sell_item instead.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        amount: { type: "number", description: "Gold to add (positive) or deduct (negative)." },
        reason: { type: "string", description: "Brief reason, e.g. 'found a coin purse'." },
      },
      required: ["player_name", "amount"],
    },
  },
  {
    name: "add_item",
    description:
      "Add an item to a player's inventory (loot found, a quest item given, etc.) without any " +
      "gold changing hands. For a shop purchase, use buy_item instead.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        item_name: { type: "string", description: "The item's name." },
        quantity: { type: "number", description: "How many to add (default 1)." },
        equip_type: {
          type: "string",
          enum: EQUIPMENT_TYPES,
          description:
            "Optional — only set this if the item is meaningfully a weapon/armor/shield, not " +
            "for ordinary loot/quest items/consumables. 'weapon': a mechanical bonus applies " +
            "later when a player wields it via skill_check's item_used, if it matches one of " +
            "equip_stats. 'armor' or 'shield': the bonus applies automatically and passively to " +
            "that character's defense DC in monster_attack, no further tool call needed. Base " +
            "this purely on what the item fictionally IS (a sword, a breastplate, a raygun, " +
            "'Frostbrand' the enchanted blade — anything you'd narrate as a weapon or protective " +
            "gear), never on keywords in its name.",
        },
        equip_stats: {
          type: "array",
          items: { type: "string", enum: VALID_STATS },
          description:
            "Required if equip_type is 'weapon': which stat(s) this weapon suits, your own " +
            "judgment based on what it fictionally is — e.g. ['str'] for a heavy melee weapon, " +
            "['dex'] for something ranged/thrown, ['str','dex'] for a light finesse weapon " +
            "usable either way, ['int','wis','cha'] for a spellcasting focus. Ignored for " +
            "armor/shield.",
        },
        equip_tier: {
          type: "string",
          enum: ["standard", "fine", "legendary"],
          description:
            "Only meaningful alongside equip_type. How powerful this gear is, by your own " +
            "judgment of its fictional significance: 'standard' (ordinary gear — the default if " +
            "omitted), 'fine' (masterwork/exceptional), 'legendary' (rare, story-significant, or " +
            "magical). Higher tiers grant a bigger mechanical bonus.",
        },
      },
      required: ["player_name", "item_name"],
    },
  },
  {
    name: "remove_item",
    description:
      "Remove an item from a player's inventory (used up, lost, stolen, given away) without " +
      "any gold changing hands. For a shop sale, use sell_item instead.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        item_name: { type: "string", description: "The item's name." },
        quantity: { type: "number", description: "How many to remove (default 1)." },
      },
      required: ["player_name", "item_name"],
    },
  },
  {
    name: "buy_item",
    description:
      "Purchase an item from a shop for a player: atomically checks they can afford it, then " +
      "deducts the gold and adds the item together. Always use this (not add_item + " +
      "modify_wallet) for shop purchases.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        item_name: { type: "string", description: "The item's name." },
        price: { type: "number", description: "Price per item, in gold." },
        quantity: { type: "number", description: "How many to buy (default 1)." },
        equip_type: {
          type: "string",
          enum: EQUIPMENT_TYPES,
          description: "Optional — same meaning as add_item's equip_type; set this if what's being bought is meaningfully a weapon/armor/shield.",
        },
        equip_stats: {
          type: "array",
          items: { type: "string", enum: VALID_STATS },
          description: "Same meaning as add_item's equip_stats — required if equip_type is 'weapon'.",
        },
        equip_tier: {
          type: "string",
          enum: ["standard", "fine", "legendary"],
          description: "Same meaning as add_item's equip_tier — defaults to 'standard' if omitted.",
        },
      },
      required: ["player_name", "item_name", "price"],
    },
  },
  {
    name: "sell_item",
    description:
      "Sell an item from a player's inventory to a shop: atomically checks they have it, then " +
      "removes the item and adds the gold together. Always use this (not remove_item + " +
      "modify_wallet) for shop sales.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's Discord username." },
        item_name: { type: "string", description: "The item's name." },
        price: { type: "number", description: "Price per item, in gold." },
        quantity: { type: "number", description: "How many to sell (default 1)." },
      },
      required: ["player_name", "item_name", "price"],
    },
  },
];

const MECHANICS_ACTION_NAMES = new Set(MECHANICS_FUNCTION_DECLARATIONS.map((decl) => decl.name));

export function isMechanicsAction(name) {
  return MECHANICS_ACTION_NAMES.has(name);
}

export async function runMechanicsAction(name, args, ctx) {
  const channelId = ctx?.channelId;
  switch (name) {
    case "skill_check":
      return skillCheck(channelId, args?.player_name, args?.stat, args?.difficulty, args?.required_successes, args?.item_used);
    case "spawn_monster":
      return spawnMonster(channelId, args?.name, args?.max_hp);
    case "apply_damage":
      return applyDamage(channelId, args?.target_type, args?.target_name, args?.amount, args?.reason);
    case "monster_attack":
      return monsterAttack(channelId, args?.monster_name, args?.target_player_name, args?.defense_stat);
    case "revive_character":
      return reviveCharacter(channelId, args?.player_name, args?.hp_restored, args?.cost, args?.payer_name);
    case "add_exp":
      return addExp(channelId, args?.player_name, args?.amount);
    case "modify_character_stat":
      return modifyCharacterStat(channelId, args?.player_name, args?.stat, args?.delta);
    case "modify_wallet":
      return modifyWallet(channelId, args?.player_name, args?.amount);
    case "add_item":
      return addItem(channelId, args?.player_name, args?.item_name, args?.quantity, args?.equip_type, args?.equip_stats, args?.equip_tier);
    case "remove_item":
      return removeItem(channelId, args?.player_name, args?.item_name, args?.quantity);
    case "buy_item":
      return buyItem(channelId, args?.player_name, args?.item_name, args?.price, args?.quantity, args?.equip_type, args?.equip_stats, args?.equip_tier);
    case "sell_item":
      return sellItem(channelId, args?.player_name, args?.item_name, args?.price, args?.quantity);
    default:
      return "ERROR: unknown D&D mechanics action.";
  }
}
