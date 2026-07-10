// dnd.js
// Lightweight D&D one-shot session state + mechanics, kept separate from the normal chat
// history so a session's story doesn't bleed into ordinary Ayame conversation. Owns no
// Gemini client of its own — index.js drives the actual model calls, this file just tracks
// state and executes the one tool the model can call mid-story (rolling dice for real).

import { createJsonStore } from "./jsonStore.js";
import {
  loadMechanicsState,
  MECHANICS_FUNCTION_DECLARATIONS,
  isMechanicsAction,
  runMechanicsAction,
  clearMechanicsState,
  hasCharacter,
  getCharacter,
  getCharacterSheet,
  createCharacter,
  buildPartyStatusText,
  trainStat,
  STAT_CAP,
} from "./dndMechanics.js";

const { DND_MAX_TURNS = "40" } = process.env;
const maxTurns = Math.max(2, parseInt(DND_MAX_TURNS, 10) || 40);

const sessionStore = createJsonStore("dnd-sessions.json");
const sessions = sessionStore.data; // channelId -> Session
const scheduleSave = sessionStore.scheduleSave;

export async function loadDndSessions() {
  await Promise.all([sessionStore.load(), loadMechanicsState()]);
}

export function hasDndSession(channelId) {
  return sessions.has(channelId);
}

export function getDndSession(channelId) {
  return sessions.get(channelId);
}

export async function startDndSession(channelId, guildId, theme, userId) {
  const now = new Date().toISOString();
  sessions.set(channelId, {
    channelId,
    guildId,
    theme: theme || null,
    startedAt: now,
    startedBy: userId,
    history: [],
    // Running count of completed exchanges (incremented in appendDndTurn below) — drives
    // pacing in persona.js. Deliberately separate from history.length, which shrinks whenever
    // compactDndHistory runs; turnCount must keep counting up regardless, or pacing would
    // think the story is younger than it actually is after a compaction.
    turnCount: 0,
    // Condensed recap of everything compacted out of `history` so far — see
    // compactDndHistory below and summarizeDndHistory in index.js. Empty until the first
    // compaction happens.
    summary: "",
    lastActivityAt: now,
  });
  await scheduleSave();
}

export async function endDndSession(channelId) {
  sessions.delete(channelId);
  await clearMechanicsState(channelId);
  await scheduleSave();
}

export async function appendDndTurn(channelId, role, text) {
  const session = sessions.get(channelId);
  if (!session) return;
  session.history.push({ role, parts: [{ text }] });
  if (role === "model") session.turnCount = (session.turnCount || 0) + 1;
  // Hard safety cap — normally compactDndHistory (driven from index.js, see
  // maybeCompactDndHistory) keeps history well under this via summarization; this is just a
  // last-resort net (blind drop, no summary) in case compaction is ever skipped.
  if (session.history.length > maxTurns) {
    session.history.splice(0, session.history.length - maxTurns);
  }
  session.lastActivityAt = new Date().toISOString();
  await scheduleSave();
}

// Replaces the raw recent-turns window with `recentEntries` and records `newSummary` as the
// condensed recap of everything older — called from index.js's maybeCompactDndHistory once it
// decides history has grown past the compaction threshold. session.turnCount is untouched
// (see startDndSession) so pacing keeps counting the true number of exchanges regardless.
export async function compactDndHistory(channelId, newSummary, recentEntries) {
  const session = sessions.get(channelId);
  if (!session) return;
  session.summary = newSummary;
  session.history = recentEntries;
  await scheduleSave();
}

export { hasCharacter, getCharacter, getCharacterSheet, createCharacter, buildPartyStatusText, trainStat, STAT_CAP };

// Function-calling tools for the D&D chat flow (see askAyameDnd in index.js): roll_dice lets
// Ayame resolve uncertain actions with a real dice roll instead of inventing an outcome; the
// rest (spawn_monster, apply_damage, add_exp, ...) come from dndMechanics.js and cover
// character/inventory/wallet/monster bookkeeping.
const ROLL_DICE_DECLARATION = {
  name: "roll_dice",
  description:
    "Roll dice to resolve an uncertain action during the D&D session — attack rolls, " +
    "skill checks, saving throws, risky stunts. ALWAYS call this instead of inventing a " +
    "result. Never call this outside an active D&D session.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      notation: { type: "string", description: "Standard dice notation, e.g. '1d20+5', '2d6'." },
      reason: { type: "string", description: "Brief reason for the roll, e.g. 'Stealth check vs the guard'." },
    },
    required: ["notation"],
  },
};

export const DND_FUNCTION_DECLARATIONS = [ROLL_DICE_DECLARATION, ...MECHANICS_FUNCTION_DECLARATIONS];

const ROLL_DICE_NAME = ROLL_DICE_DECLARATION.name;

export function isDndAction(name) {
  return name === ROLL_DICE_NAME || isMechanicsAction(name);
}

const DICE_NOTATION_PATTERN = /^(\d{1,2})d(\d{1,3})\s*([+-]\s*\d{1,3})?$/i;

export function rollDice(notation) {
  const match = typeof notation === "string" ? notation.trim().match(DICE_NOTATION_PATTERN) : null;
  if (!match) {
    return `ERROR: couldn't parse dice notation "${notation}". Use something like "1d20+3".`;
  }

  const count = Math.min(Math.max(parseInt(match[1], 10), 1), 20);
  const sides = Math.min(Math.max(parseInt(match[2], 10), 2), 1000);
  const modifier = match[3] ? parseInt(match[3].replace(/\s/g, ""), 10) : 0;

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((sum, roll) => sum + roll, 0) + modifier;

  let flavor = "";
  if (count === 1 && sides === 20) {
    if (rolls[0] === 20) flavor = " (Natural 20 — critical success!)";
    else if (rolls[0] === 1) flavor = " (Natural 1 — critical failure!)";
  }

  const modifierText = modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : "";
  return `OK: rolled ${notation} -> [${rolls.join(", ")}]${modifierText} = ${total}${flavor}`;
}

export async function runDndAction(name, args, ctx) {
  if (name === ROLL_DICE_NAME) return rollDice(args?.notation);
  if (isMechanicsAction(name)) return runMechanicsAction(name, args, ctx);
  return "ERROR: unknown D&D action.";
}
