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
  const maxHp = 10 + con;
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
  getChannelBucket(inventories, channelId)[username] = [];
  getChannelBucket(wallets, channelId)[username] = STARTING_GOLD;

  await Promise.all([characters.scheduleSave(), inventories.scheduleSave(), wallets.scheduleSave()]);
  return charBucket[username];
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
    const items = (inv[username] || []).map((i) => `${i.item} x${i.quantity}`).join(", ") || "empty";
    const gold = wallet[username] ?? 0;
    // Username leads and is the ONLY thing tool calls should ever use to identify this
    // player — the flavor name is marked "aka" specifically so it reads as secondary, not
    // the primary identifier (Gemini has previously echoed the flavor name back into
    // player_name/target_name args, which fails to resolve).
    const label = c.name ? `${username} (aka "${c.name}")` : username;
    return (
      `${label} [${c.class}] — Lvl ${c.level}, HP ${c.currentHp}/${c.maxHp}, EXP ${c.exp}/${c.level * 100}, ` +
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
async function skillCheck(channelId, playerName, stat, difficulty, requiredSuccesses) {
  if (!VALID_STATS.includes(stat)) return `ERROR: stat must be one of ${VALID_STATS.join(", ")}.`;
  if (!DIFFICULTY_DC[difficulty]) return `ERROR: difficulty must be one of ${Object.keys(DIFFICULTY_DC).join(", ")}.`;

  const count = Math.min(Math.max(parseInt(requiredSuccesses, 10) || 1, 1), MAX_REQUIRED_SUCCESSES);
  const dc = DIFFICULTY_DC[difficulty];

  const bucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(bucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;

  const character = bucket[key];
  const modifier = Math.floor(character.stats[stat] / 5);

  const rolls = [];
  let allSucceeded = true;
  for (let i = 0; i < count; i++) {
    const outcome = rollD20WithModifier(modifier, dc);
    rolls.push(outcome);
    if (!outcome.success) allSucceeded = false;
  }

  const rollSummary = rolls
    .map((r) => `${r.roll}${r.modifierText}=${r.total}${r.success ? "✓" : "✗"}${r.flavor}`)
    .join(", ");
  const successCount = rolls.filter((r) => r.success).length;

  return (
    `OK: ${key}'s ${stat.toUpperCase()} check (DC ${dc}${count > 1 ? `, needed ${count}/${count} successes` : ""}) ` +
    `— [${rollSummary}] (${successCount}/${count} succeeded) — ${allSucceeded ? "SUCCESS" : "FAILURE"}.`
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
    character.currentHp = Math.min(character.maxHp, Math.max(0, character.currentHp - amount));
    await characters.scheduleSave();
    const downed = character.currentHp <= 0;
    return `OK: ${key} ${verb} ${magnitude} ${noun} (${character.currentHp}/${character.maxHp} HP)${downed ? " — knocked unconscious!" : ""}.`;
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

  // Attack bonus ties directly to the toughness (maxHp) Gemini already judged at spawn_monster
  // time — no separate field for her to independently decide and risk being inconsistent
  // about. Defense DC comes from the target's real stored stat, same modifier scale as
  // skill_check — deterministic on both sides of the roll.
  const attackBonus = Math.floor(monster.maxHp / 5);
  const dc = 10 + Math.floor(target.stats[defenseStat] / 5);
  const { roll, total, success, flavor, modifierText } = rollD20WithModifier(attackBonus, dc);

  return (
    `OK: ${monsterKey} attacks ${targetKey} (${defenseStat.toUpperCase()} defense, DC ${dc}) — ` +
    `rolled ${roll}${modifierText} = ${total} — ${success ? "HIT" : "MISS"}${flavor}.`
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

async function addItem(channelId, playerName, itemName, quantity) {
  quantity = Number(quantity) || 1;
  if (!itemName) return "ERROR: add_item needs an item_name.";
  const charBucket = characters.data.get(channelId) || {};
  const key = findCharacterKey(charBucket, playerName);
  if (!key) return `ERROR: no character found for "${playerName}".`;
  const invBucket = getChannelBucket(inventories, channelId);
  const items = invBucket[key] || (invBucket[key] = []);
  const existing = items.find((i) => i.item.toLowerCase() === itemName.toLowerCase());
  if (existing) existing.quantity += quantity;
  else items.push({ item: itemName, quantity });
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

async function buyItem(channelId, playerName, itemName, price, quantity) {
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
  else items.push({ item: itemName, quantity });

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
      "without calling this first.",
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
      return skillCheck(channelId, args?.player_name, args?.stat, args?.difficulty, args?.required_successes);
    case "spawn_monster":
      return spawnMonster(channelId, args?.name, args?.max_hp);
    case "apply_damage":
      return applyDamage(channelId, args?.target_type, args?.target_name, args?.amount, args?.reason);
    case "monster_attack":
      return monsterAttack(channelId, args?.monster_name, args?.target_player_name, args?.defense_stat);
    case "add_exp":
      return addExp(channelId, args?.player_name, args?.amount);
    case "modify_character_stat":
      return modifyCharacterStat(channelId, args?.player_name, args?.stat, args?.delta);
    case "modify_wallet":
      return modifyWallet(channelId, args?.player_name, args?.amount);
    case "add_item":
      return addItem(channelId, args?.player_name, args?.item_name, args?.quantity);
    case "remove_item":
      return removeItem(channelId, args?.player_name, args?.item_name, args?.quantity);
    case "buy_item":
      return buyItem(channelId, args?.player_name, args?.item_name, args?.price, args?.quantity);
    case "sell_item":
      return sellItem(channelId, args?.player_name, args?.item_name, args?.price, args?.quantity);
    default:
      return "ERROR: unknown D&D mechanics action.";
  }
}
