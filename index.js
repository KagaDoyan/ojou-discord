// index.js
// Discord bot that chats using Gemini, roleplaying as "Ayame" (Nakiri Ayame persona).

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { AYAME_PERSONA, AYAME_DM_PERSONA, buildDndInstructions } from "./persona.js";
import {
  createDistube,
  handlePlay,
  handleSkip,
  handleQueue,
  handleRemove,
  handleJump,
  handlePause,
  handleResume,
  handleLeave,
  handleShuffle,
  handleRepeat,
  handleMusicButton,
  MUSIC_FUNCTION_DECLARATIONS,
  isMusicAction,
  runMusicAction,
} from "./music.js";
import {
  loadDndSessions,
  hasDndSession,
  getDndSession,
  startDndSession,
  endDndSession,
  appendDndTurn,
  compactDndHistory,
  DND_FUNCTION_DECLARATIONS,
  isDndAction,
  runDndAction,
  rollDice,
  hasCharacter,
  getCharacterSheet,
  createCharacter,
  buildPartyStatusText,
  trainStat,
  STAT_CAP,
} from "./dnd.js";

const {
  DISCORD_TOKEN,
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-3.1-flash-lite",
  // gemini-3.1 and gemini-2.0 have no free-tier grounding quota on this key;
  // gemini-2.5 does, so search grounding is routed through this model instead.
  GEMINI_GROUNDING_MODEL = "gemini-2.5-flash-lite",
  ALLOWED_CHANNEL_IDS = "",
  MAX_TURNS = "20",
  DEFAULT_LOCATION = "Vientiane, Laos",
  DEFAULT_TIMEZONE = "Asia/Vientiane", // UTC+7 (Indochina Time)
} = process.env;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

const allowedChannels = new Set(
  ALLOWED_CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean)
);
const maxTurns = Math.max(1, parseInt(MAX_TURNS, 10) || 20);

// channels currently in "active chat" mode: once triggered by a mention, Ayame
// replies to every message in that channel (no @ needed) until told to stop.
const activeChannels = new Set();

const STOP_MESSAGE = "Ahaha, okay~ I'll go quiet until you call me again. Bye for now!";
const START_MESSAGE = "Ooh, active chat mode! I'm all ears now — no need to @ me, just talk~";

const DND_HOW_TO_MESSAGE = `**How to play D&D with Ayame~**

**1.** Someone runs \`/dnd start\` (optionally \`theme:<idea>\`) to begin a session in this channel. No theme? Ayame will ask what you're in the mood for or make one up.

**2.** Everyone who wants to play runs \`/create_character\` — pick a \`class\` (any flavor you want, fantasy or sci-fi), split exactly **100 points** across \`str\`/\`dex\`/\`con\`/\`int\`/\`wis\`/\`cha\`, and optionally add a \`name\` and \`background\` (a hobby/skill/backstory bit).

**3.** Just talk! No @ mention needed — say what your character does ("I search the room", "I attack the goblin", "I try to persuade the guard"). Ayame rolls real dice against your actual stats behind the scenes.

**4.** Fight monsters, loot, shop, and level up — HP, gold, inventory, and EXP are all tracked for real, not just narrated.

**5.** Want a quick roll outside the story? \`/dnd roll notation:1d20+3\`.

**6.** When you're done, \`/dnd end\` wraps up the story and clears the session.

Anyone without a character yet will get reminded to run \`/create_character\` before jumping in~`;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// conversationKey -> array of { role: 'user' | 'model', parts: [{ text }] }
const histories = new Map();

function getHistory(key) {
  if (!histories.has(key)) histories.set(key, []);
  return histories.get(key);
}

function pushTurn(key, role, text) {
  const history = getHistory(key);
  history.push({ role, parts: [{ text }] });
  // keep only the last `maxTurns` user+model turn-pairs
  const maxEntries = maxTurns * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

function buildLocalizationContext() {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  return (
    `LOCALIZATION CONTEXT: Right now it is ${formatted} in ${DEFAULT_LOCATION} (UTC+7). ` +
    `Unless the user names a different place, assume ${DEFAULT_LOCATION} for anything ` +
    `location-based: weather, local news, nearby events, "what time is it", time-of-day ` +
    `greetings, etc. Use this as the current date/time for "today"/"now", including when ` +
    `deciding what to search for.`
  );
}

// Lets the persona model decide for itself whether a message needs a live
// search, instead of a keyword regex. This is a *custom* function-declaration
// tool — handled entirely client-side (we execute it ourselves below) — not
// the built-in googleSearch grounding tool, so it never touches that tool's
// separate (and much smaller) quota. gemini-3.1 just proposes calling it;
// the actual grounded lookup still runs on GEMINI_GROUNDING_MODEL.
const SEARCH_TOOL = {
  functionDeclarations: [
    {
      name: "search_web",
      description:
        "Search the web for information that requires current, real-time, or " +
        "post-training-cutoff knowledge — news, weather, sports scores, prices, " +
        "recent events, etc. Only call this when you genuinely can't answer " +
        "confidently from what you already know; don't call it for ordinary chat.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "A concise, well-formed web search query." },
        },
        required: ["query"],
      },
    },
  ],
};

async function fetchGroundedContext(query) {
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_GROUNDING_MODEL,
      contents: [{ role: "user", parts: [{ text: query }] }],
      config: {
        systemInstruction:
          "Answer factually and concisely using up-to-date search results. " +
          "No roleplay, no persona — just the relevant facts.",
        maxOutputTokens: 400,
        tools: [{ googleSearch: {} }],
      },
    });
    return res.text?.trim() || null;
  } catch (err) {
    console.error("Grounding lookup failed, continuing without it:", err?.message || err);
    return null;
  }
}

// musicContext is only present for messages sent in a guild (not DMs), since music playback
// needs a guild + voice channel; when present it unlocks the music function-declarations below
// so Ayame can act on requests like "play <song>" without a slash command.
async function askAyame(key, userText, musicContext = null) {
  const history = getHistory(key);
  const contents = [...history, { role: "user", parts: [{ text: userText }] }];
  const systemInstruction = `${AYAME_PERSONA}\n\n${buildLocalizationContext()}`;
  const tools = musicContext
    ? [{ functionDeclarations: [...SEARCH_TOOL.functionDeclarations, ...MUSIC_FUNCTION_DECLARATIONS] }]
    : [SEARCH_TOOL];

  let response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction,
      temperature: 1.1,
      maxOutputTokens: 1200,
      tools,
    },
  });

  const call = response.functionCalls?.[0];

  if (call?.name === "search_web" || (musicContext && isMusicAction(call?.name))) {
    const resultText =
      call.name === "search_web"
        ? (await fetchGroundedContext(typeof call.args?.query === "string" ? call.args.query : userText)) ||
          "No result available right now."
        : await runMusicAction(call.name, call.args, musicContext);

    // Feed the result back as a function response and let the model produce
    // its final, in-character answer from it.
    //
    // Two things matter here, found by testing against the live API:
    //  - Replay response.candidates[0].content verbatim (not a hand-built
    //    { functionCall: call } part) — Gemini 3 attaches a required
    //    thoughtSignature to that part, and reconstructing it drops that
    //    field, which 400s on the next call.
    //  - Keep `tools` (and systemInstruction) on this follow-up call too —
    //    without them the model ignored the function response entirely and
    //    asked the user for info it had just been given.
    const followupContents = [
      ...contents,
      response.candidates[0].content,
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: call.name,
              response: { output: resultText },
            },
          },
        ],
      },
    ];

    response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: followupContents,
      config: {
        systemInstruction,
        temperature: 1.1,
        maxOutputTokens: 1200,
        tools,
      },
    });
  }

  const text = response.text?.trim();
  if (!text) throw new Error("Empty response from Gemini");

  pushTurn(key, "user", userText);
  pushTurn(key, "model", text);
  return text;
}

// A single combat/shop action can need several dependent tool calls in sequence (skill_check ->
// decide damage from the result -> apply_damage -> monster_attack -> apply_damage -> add_exp ->
// add_item, etc.) — each one only knowable after the previous result comes back. A rich combat
// exchange can easily use 6+ calls on its own (that was the old cap here — too tight in
// practice, it was being hit routinely and forcing narration into the no-tools fallback below
// mid-exchange, which is why HP/EXP/items were getting narrated without ever actually being
// applied). This caps how many such steps one player turn can chain through before we just
// return whatever text we have, so a confused model still can't loop forever.
const MAX_DND_TOOL_STEPS = 12;

// monster_attack's OK: result string is already close to display-ready (unlike skill_check's,
// which needs real reformatting for multi-roll checks) — just strip the tool-result prefix and
// flag it visually. Shown automatically, no click needed (unlike the player's own roll), since
// this is the DM's roll happening to the player, not something they're doing themselves.
function formatMonsterAttackReveal(resultText) {
  return `🎯 ${resultText.replace(/^OK: /, "")}`;
}

function prependReveals(reveals, text) {
  return reveals.length ? `${reveals.join("\n")}\n\n${text}` : text;
}

// Runs the D&D tool-call loop starting at `contents`/`step`. Every dnd action resolves and
// feeds back immediately EXCEPT skill_check, which pauses the loop entirely (see
// askAyameDnd/postPendingRoll/resolvePendingDndRoll below) — the roll is already computed the
// instant this returns, but withheld from Gemini (and the channel) until the player reveals it
// via the 🎲 button or `/dnd roll`, so it feels like their own roll instead of an invisible one.
// `initialMonsterAttackReveals` carries forward any monster_attack reveals collected before a
// skill_check pause, so they still show up once the turn actually finishes.
async function runDndLoop(channelId, contents, systemInstruction, tools, startStep, initialMonsterAttackReveals = []) {
  const monsterAttackReveals = [...initialMonsterAttackReveals];
  for (let step = startStep; step < MAX_DND_TOOL_STEPS; step++) {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction, temperature: 1.1, maxOutputTokens: 1200, tools },
    });

    const call = response.functionCalls?.[0];
    if (!call || !isDndAction(call.name)) {
      const text = response.text?.trim();
      if (!text) throw new Error("Empty response from Gemini");
      return { done: true, text: prependReveals(monsterAttackReveals, text) };
    }

    const resultText = await runDndAction(call.name, call.args, { channelId });

    if (call.name === "monster_attack" && resultText.startsWith("OK:")) {
      monsterAttackReveals.push(formatMonsterAttackReveal(resultText));
    }

    // Only pause for a genuine roll — if skill_check itself errored (bad args, character not
    // found, etc.) there's nothing to reveal, so feed the error straight back like any other
    // tool call and let Gemini retry/self-correct within this same turn instead of showing the
    // player a roll prompt that would just reveal "ERROR: ..." when clicked.
    if (call.name === "skill_check" && resultText.startsWith("OK:")) {
      return {
        done: false,
        pending: {
          resultText,
          call,
          // Same required pattern as askAyame's function-calling follow-up: replay
          // response.candidates[0].content verbatim to preserve Gemini 3's thoughtSignature.
          contents: [...contents, response.candidates[0].content],
          systemInstruction,
          tools,
          nextStep: step + 1,
          monsterAttackReveals,
        },
      };
    }

    contents = [
      ...contents,
      response.candidates[0].content,
      { role: "user", parts: [{ functionResponse: { name: call.name, response: { output: resultText } } }] },
    ];
  }

  // Hit the step cap — ask once more with tools withheld so the model is forced to produce
  // narration instead of another call, rather than silently dropping the last tool result. This
  // call genuinely cannot make any more tool calls, so explicitly warn against inventing further
  // mechanical outcomes (HP/EXP/items/etc.) that haven't already been resolved by a real tool
  // call earlier in `contents` — without this, a model that still has more it "wants" to
  // resolve tends to just narrate it anyway since it has no other way to express it.
  const finalResponse = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction:
        systemInstruction +
        "\n\n[You are out of tool calls for this turn. The GOLDEN RULE above still applies: " +
        "narrate only what's already been resolved by the tool results above. Wrap up this " +
        "beat naturally; anything still unresolved can happen next turn.]",
      temperature: 1.1,
      maxOutputTokens: 1200,
    },
  });
  const finalText = finalResponse.text?.trim();
  if (!finalText) throw new Error("Empty response from Gemini");
  return { done: true, text: prependReveals(monsterAttackReveals, finalText) };
}

// Sibling to askAyame, scoped to an active D&D session: uses the session's own history (kept
// fully separate from the normal chat `histories`) and the D&D tool set (roll_dice + the
// character/inventory/wallet/monster mechanics tools) — SEARCH_TOOL is deliberately excluded
// so narration can't wander off into live web lookups mid-story. The caller is expected to
// have already appended the new turn to the session via appendDndTurn before calling this, so
// `session.history` already includes it. Returns the narration text, OR null if a skill_check
// paused the turn — in that case a 🎲 roll-prompt message has already been sent to `channel`
// and there's nothing further for the caller to send right now.
async function askAyameDnd(channelId, session, channel, actingUsername = null) {
  const partyStatus = buildPartyStatusText(channelId);
  const systemInstruction =
    AYAME_DM_PERSONA +
    buildDndInstructions({
      theme: session.theme,
      turnCount: session.turnCount || 0,
      partyStatus,
      storySummary: session.summary || "",
    }) +
    `\n\n${buildLocalizationContext()}`;
  const tools = [{ functionDeclarations: DND_FUNCTION_DECLARATIONS }];

  const result = await runDndLoop(channelId, session.history, systemInstruction, tools, 0);
  if (result.done) return result.text;

  await postPendingRoll(channelId, channel, actingUsername, result.pending);
  return null;
}

// Once session.history grows past this many raw entries (~7 exchanges), maybeCompactDndHistory
// folds everything older than DND_HISTORY_KEEP_RECENT into session.summary via one cheap
// summarization call, instead of either sending the whole growing transcript every turn or
// (the old behavior) silently dropping it once DND_MAX_TURNS is hit with no summary at all.
const DND_HISTORY_COMPACT_THRESHOLD = 14;
const DND_HISTORY_KEEP_RECENT = 10;

// Condenses `turnsToCompact` (oldest entries about to be dropped from session.history) plus any
// existing summary into an updated recap. Deliberately not run through askAyameDnd/Ayame's
// persona — this is a plain, no-roleplay task, and reuses GEMINI_GROUNDING_MODEL (already the
// "cheap, fast, task-only" model in this codebase) rather than the main persona model, since
// it fires periodically in the background rather than once per turn. Returns null (not the old
// summary) on failure — a distinct signal so the caller knows NOT to compact history this turn:
// silently keeping the old summary while still trimming history would quietly delete whatever
// happened in `turnsToCompact` with nothing recording it, which defeats the entire point of
// summarizing instead of just dropping old turns.
async function summarizeDndHistory(oldSummary, turnsToCompact) {
  const transcript = turnsToCompact
    .map((turn) => `${turn.role === "user" ? "Player" : "Ayame"}: ${turn.parts?.[0]?.text ?? ""}`)
    .join("\n");
  const prompt =
    (oldSummary ? `EXISTING SUMMARY SO FAR:\n${oldSummary}\n\n` : "") +
    `NEW EVENTS TO FOLD IN:\n${transcript}\n\n` +
    "Condense the above into an updated, compact running summary of this D&D session's story " +
    "so far. Preserve: quests/objectives given and their current status, key NPCs and " +
    "relationships, important items/discoveries, and major decisions/consequences. Drop minor " +
    "flavor text and small talk. Write it as a tight prose recap, a few sentences to a short " +
    "paragraph — not a bullet list, not a transcript.";

  try {
    const res = await ai.models.generateContent({
      model: GEMINI_GROUNDING_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: "You condense tabletop RPG session logs into compact recaps. No roleplay, no persona — just an accurate, concise summary.",
        maxOutputTokens: 300,
      },
    });
    return res.text?.trim() || oldSummary || "";
  } catch (err) {
    console.error("Failed to summarize dnd history, will retry next turn:", err?.message || err);
    return null;
  }
}

async function maybeCompactDndHistory(channelId, session) {
  if (!session || session.history.length <= DND_HISTORY_COMPACT_THRESHOLD) return;
  const toCompact = session.history.slice(0, session.history.length - DND_HISTORY_KEEP_RECENT);
  const toKeep = session.history.slice(session.history.length - DND_HISTORY_KEEP_RECENT);
  const newSummary = await summarizeDndHistory(session.summary, toCompact);
  if (newSummary === null) return; // summarization failed — skip compaction, try again next turn
  await compactDndHistory(channelId, newSummary, toKeep);
}

// channelId -> { resultText, call, contents, systemInstruction, tools, nextStep, actingUsername,
//                channel, buttonMessage, timeoutHandle }
const pendingDndRolls = new Map();
const PENDING_ROLL_TIMEOUT_MS = 180_000; // 3 min — auto-resolves so an AFK player can't stall the session
const DND_ROLL_BUTTON_ID = "dnd:roll";

// Mirrors dndMechanics.js's internal DIFFICULTY_DC table (not exported) — purely for display
// in the pre-roll/reveal messages here. The actual DC used by the mechanic itself always comes
// from dndMechanics.js; this duplicate never drives any outcome, only what's printed.
const DND_DIFFICULTY_DC = { easy: 8, medium: 12, hard: 16, very_hard: 20 };

function buildDndRollButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(DND_ROLL_BUTTON_ID).setLabel("Roll").setEmoji("🎲").setStyle(ButtonStyle.Primary)
  );
}

function buildStatBar(current, max, length = 10) {
  if (!max || max <= 0) return "";
  const ratio = Math.min(Math.max(current / max, 0), 1);
  const filled = Math.round(ratio * length);
  return "▰".repeat(filled) + "▱".repeat(Math.max(length - filled, 0));
}

// /dnd stat's character sheet card.
function buildCharacterSheetEmbed(sheet, requestedBy) {
  const { username, character: c, inventory, gold } = sheet;
  const label = c.name ? `${c.name} (${username})` : username;
  const inventoryText = inventory.length ? inventory.map((i) => `• ${i.item} x${i.quantity}`).join("\n") : "_Empty_";

  const embed = new EmbedBuilder()
    .setColor(0xf7b8d2)
    .setTitle(`📜 ${label}`)
    .setDescription(`**${c.class}** — Level ${c.level}`)
    .addFields(
      { name: "❤️ HP", value: `${buildStatBar(c.currentHp, c.maxHp)}\n${c.currentHp}/${c.maxHp}`, inline: true },
      { name: "✨ EXP", value: `${c.exp}/${c.level * 100}`, inline: true },
      { name: "💰 Gold", value: `${gold}`, inline: true },
      {
        name: "📊 Stats",
        value:
          `STR ${c.stats.str}  DEX ${c.stats.dex}  CON ${c.stats.con}\n` +
          `INT ${c.stats.int}  WIS ${c.stats.wis}  CHA ${c.stats.cha}`,
        inline: false,
      },
      { name: "🎒 Inventory", value: inventoryText, inline: false }
    );

  if (c.unspentStatPoints) {
    embed.addFields({
      name: "⭐ Unspent Stat Points",
      value: `${c.unspentStatPoints} (use \`/dnd train\`)`,
      inline: false,
    });
  }
  if (c.background) {
    embed.addFields({ name: "📖 Background", value: c.background, inline: false });
  }

  embed.setFooter({ text: `Requested by ${requestedBy}` });
  return embed;
}

async function postPendingRoll(channelId, channel, actingUsername, pending) {
  const { call } = pending;
  const dc = DND_DIFFICULTY_DC[call.args?.difficulty] ?? "?";
  const promptText =
    `🎲 **${(call.args?.stat || "").toUpperCase()} check**${call.args?.reason ? ` — ${call.args.reason}` : ""} ` +
    `(needed ${dc} to succeed)\n` +
    `${actingUsername ? `**${actingUsername}**, ` : ""}click below to roll (or use \`/dnd roll\`)~`;
  const buttonMessage = await channel.send({ content: promptText, components: [buildDndRollButtonRow()] });

  const timeoutHandle = setTimeout(() => {
    resolvePendingDndRoll(channelId, null).catch((err) => console.error("Error auto-resolving dnd roll:", err));
  }, PENDING_ROLL_TIMEOUT_MS);

  pendingDndRolls.set(channelId, { ...pending, actingUsername, channel, buttonMessage, timeoutHandle });
}

const SKILL_CHECK_RESULT_PATTERN =
  /^OK: (.+?)'s (\w+) check \(DC \d+(?:, needed \d+\/\d+ successes)?\) — \[(.+)\] \((\d+)\/(\d+) succeeded\) — (SUCCESS|FAILURE)\.$/;
const SKILL_CHECK_ROLL_SEGMENT_PATTERN = /^(\d+)([+-]\d+)=(-?\d+)(✓|✗)(.*)$/;

// Turns skillCheck()'s plain result string (already computed, held back from Gemini/the
// channel until now) into the detailed reveal format. Falls back to showing the raw string
// verbatim if it doesn't match the expected shape (e.g. an ERROR result) — never hides it.
function formatRollReveal(pending) {
  const { resultText, call } = pending;
  const dc = DND_DIFFICULTY_DC[call.args?.difficulty] ?? "?";
  const match = resultText.match(SKILL_CHECK_RESULT_PATTERN);
  if (!match) return `🎲 ${resultText}`;

  const [, playerKey, stat, rollsStr, successCount, totalCountStr, outcome] = match;
  const totalCount = Number(totalCountStr);

  const rollLines = rollsStr.split(", ").map((segment, i) => {
    const segMatch = segment.match(SKILL_CHECK_ROLL_SEGMENT_PATTERN);
    if (!segMatch) return segment;
    const [, roll, modifierText, total, , flavor] = segMatch;
    const prefix = totalCount > 1 ? `Roll ${i + 1}: ` : "";
    return `${prefix}rolled **${roll}** ${modifierText} (${stat} bonus) = **${total}**${flavor}`;
  });

  const reasonPart = call.args?.reason ? ` — ${call.args.reason}` : "";
  const outcomeLine = totalCount > 1 ? `${successCount}/${totalCount} succeeded — **${outcome}**` : `**${outcome}**`;

  return (
    `🎲 **${stat} check**${reasonPart} — needed **${dc}** to succeed\n` +
    `**${playerKey}** — ${rollLines.join(", ")}\n` +
    outcomeLine
  );
}

// Resolves whichever pending roll is open in `channelId` — called from the button click
// handler, `/dnd roll`, or the timeout above. `resolvingUsername` is null for the timeout path
// (skips the ownership check); returns { ok: false, reason: "none" | "not-yours" } or
// { ok: true } once the roll has been revealed and the story continues (posting either the
// next roll prompt, if the model chained another check, or the final narration).
async function resolvePendingDndRoll(channelId, resolvingUsername) {
  const pending = pendingDndRolls.get(channelId);
  if (!pending) return { ok: false, reason: "none" };
  if (resolvingUsername && pending.actingUsername && resolvingUsername !== pending.actingUsername) {
    return { ok: false, reason: "not-yours" };
  }

  pendingDndRolls.delete(channelId);
  clearTimeout(pending.timeoutHandle);

  await pending.buttonMessage.edit({ content: formatRollReveal(pending), components: [] }).catch(() => {});

  const contents = [
    ...pending.contents,
    {
      role: "user",
      parts: [{ functionResponse: { name: pending.call.name, response: { output: pending.resultText } } }],
    },
  ];
  const result = await runDndLoop(
    channelId,
    contents,
    pending.systemInstruction,
    pending.tools,
    pending.nextStep,
    pending.monsterAttackReveals
  );

  if (result.done) {
    await appendDndTurn(channelId, "model", result.text);
    await sendChunked(pending.channel, result.text);
    await maybeCompactDndHistory(channelId, getDndSession(channelId));
  } else {
    // The model chained a second check in the same turn — post another roll prompt.
    await postPendingRoll(channelId, pending.channel, pending.actingUsername, result.pending);
  }
  return { ok: true };
}

async function handleDndButton(interaction) {
  if (interaction.customId !== DND_ROLL_BUTTON_ID) return;

  const pending = pendingDndRolls.get(interaction.channelId);
  if (pending && pending.actingUsername && interaction.user.username !== pending.actingUsername) {
    await interaction.reply({ content: "This isn't your roll to make~", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();
  const outcome = await resolvePendingDndRoll(interaction.channelId, interaction.user.username);
  if (!outcome.ok && outcome.reason === "none") {
    // Rare race: someone else's click/the timeout already resolved it a moment earlier.
    // The button message was already edited by whichever resolution won; nothing more to do.
  }
}

async function sendChunked(channel, text) {
  const LIMIT = 2000;
  if (text.length <= LIMIT) {
    await channel.send(text);
    return;
  }
  for (let i = 0; i < text.length; i += LIMIT) {
    await channel.send(text.slice(i, i + LIMIT));
  }
}

async function replyChunked(interaction, text) {
  const LIMIT = 2000;
  const chunks = [];
  for (let i = 0; i < text.length; i += LIMIT) chunks.push(text.slice(i, i + LIMIT));
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

const distube = createDistube(client);

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // A /dnd session in this channel takes over entirely: no @mention needed, and it's
    // fully separate from the normal active-chat/history flow below (which is left
    // untouched and simply resumes once the session ends).
    if (hasDndSession(message.channel.id)) {
      const channelId = message.channel.id;
      if (!hasCharacter(channelId, message.author.username)) {
        await message.reply(
          "You don't have a character in this session yet~ Use `/create_character` to build one before jumping in!"
        );
        return;
      }
      if (pendingDndRolls.has(channelId)) {
        await message.reply("There's a roll waiting — click the 🎲 button above (or use `/dnd roll`) first~");
        return;
      }
      await message.channel.sendTyping();
      await appendDndTurn(channelId, "user", message.content);
      const reply = await askAyameDnd(channelId, getDndSession(channelId), message.channel, message.author.username);
      if (reply) {
        await appendDndTurn(channelId, "model", reply);
        await sendChunked(message.channel, reply);
        await maybeCompactDndHistory(channelId, getDndSession(channelId));
      }
      return;
    }

    const isDM = message.channel.type === ChannelType.DM;
    const isMentioned = message.mentions.has(client.user);
    const isAllowedChannel = allowedChannels.has(message.channel.id);
    const wasAlreadyActive = activeChannels.has(message.channel.id);

    if (!isDM && !isMentioned && !isAllowedChannel && !wasAlreadyActive) return;

    // a mention turns on "active chat" for this channel: no @ needed after this,
    // until someone sends "!ayame stop"
    const justActivated = isMentioned && !isDM && !wasAlreadyActive;
    if (justActivated) activeChannels.add(message.channel.id);

    // strip the bot mention out of the text
    const mentionPattern = new RegExp(`<@!?${client.user.id}>`, "g");
    const text = message.content.replace(mentionPattern, "").trim();

    const key = isDM ? `dm:${message.author.id}` : `channel:${message.channel.id}`;

    if (/^!ayame\s+reset$/i.test(text)) {
      histories.delete(key);
      await message.reply("Ahaha, okay, clean slate it is~ Fresh start!");
      return;
    }

    if (/^!ayame\s+stop$/i.test(text)) {
      activeChannels.delete(message.channel.id);
      await message.reply(STOP_MESSAGE);
      return;
    }

    if (justActivated && !text) {
      await message.reply(START_MESSAGE);
      return;
    }

    if (!text) {
      await message.reply("Hehe, you called me over and got nothing to say? Docchi docchi~?");
      return;
    }

    const musicContext = isDM
      ? null
      : {
          distube,
          guildId: message.guildId,
          voiceChannel: message.member?.voice?.channel ?? null,
          textChannel: message.channel,
          member: message.member,
        };

    await message.channel.sendTyping();
    const reply = await askAyame(key, text, musicContext);
    await sendChunked(message.channel, reply);
  } catch (err) {
    console.error("Error handling message:", err);
    try {
      await message.reply(
        "Ah, hold on— something glitched out on my end (an error occurred). Try again in a moment!"
      );
    } catch {
      // ignore secondary failure
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith("music:")) {
    await handleMusicButton(distube, interaction);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("dnd:")) {
    await handleDndButton(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const isDM = interaction.guildId === null;
  const key = isDM ? `dm:${interaction.user.id}` : `channel:${interaction.channelId}`;

  if (interaction.commandName === "reset") {
    histories.delete(key);
    await interaction.reply("Ahaha, okay, clean slate it is~ Fresh start!");
    return;
  }

  if (interaction.commandName === "stop") {
    if (isDM) {
      await interaction.reply("Hehe, it's already just us here~ nothing to turn off!");
      return;
    }
    activeChannels.delete(interaction.channelId);
    await interaction.reply(STOP_MESSAGE);
    return;
  }

  if (interaction.commandName === "clear") {
    if (isDM) {
      await interaction.reply({ content: "Can't do that in a DM, hehe.", ephemeral: true });
      return;
    }

    // Discord also enforces this via setDefaultMemberPermissions, but a server admin
    // could have overridden that in Integrations settings, so check again here.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: "Nuh-uh, you need the Manage Messages permission for that one~",
        ephemeral: true,
      });
      return;
    }

    const botMember = await interaction.guild.members.fetchMe();
    if (!botMember.permissionsIn(interaction.channel).has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: "Ahh, I don't have permission to delete messages here myself — give me Manage Messages and try again!",
        ephemeral: true,
      });
      return;
    }

    const amount = interaction.options.getInteger("amount") ?? 20;
    await interaction.deferReply({ ephemeral: true });
    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.editReply(
        `Poof! Cleared ${deleted.size} message${deleted.size === 1 ? "" : "s"}~ ` +
          (deleted.size < amount
            ? "(some were probably too old — Discord won't let me bulk-delete anything over 2 weeks old)"
            : "")
      );
    } catch (err) {
      console.error("Error handling /clear:", err);
      await interaction.editReply("Ugh, something went wrong trying to clear those. Try again?");
    }
    return;
  }

  if (interaction.commandName === "play") {
    await handlePlay(distube, interaction);
    return;
  }

  if (interaction.commandName === "skip") {
    await handleSkip(distube, interaction);
    return;
  }

  if (interaction.commandName === "queue") {
    await handleQueue(distube, interaction);
    return;
  }

  if (interaction.commandName === "remove") {
    await handleRemove(distube, interaction);
    return;
  }

  if (interaction.commandName === "jump") {
    await handleJump(distube, interaction);
    return;
  }

  if (interaction.commandName === "pause") {
    await handlePause(distube, interaction);
    return;
  }

  if (interaction.commandName === "resume") {
    await handleResume(distube, interaction);
    return;
  }

  if (interaction.commandName === "leave") {
    await handleLeave(distube, interaction);
    return;
  }

  if (interaction.commandName === "shuffle") {
    await handleShuffle(distube, interaction);
    return;
  }

  if (interaction.commandName === "repeat") {
    await handleRepeat(distube, interaction);
    return;
  }

  if (interaction.commandName === "dnd") {
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;

    if (sub === "start") {
      if (hasDndSession(channelId)) {
        await interaction.reply({
          content: "A session's already running here — use `/dnd end` first.",
          ephemeral: true,
        });
        return;
      }
      const theme = interaction.options.getString("theme");
      await startDndSession(channelId, interaction.guildId, theme, interaction.user.id);
      await interaction.deferReply();
      try {
        const opener = "[The session begins. Set the scene and kick off the adventure.]";
        await appendDndTurn(channelId, "user", opener);
        const reply = await askAyameDnd(channelId, getDndSession(channelId), interaction.channel, interaction.user.username);
        if (reply) {
          await appendDndTurn(channelId, "model", reply);
          await replyChunked(interaction, reply);
          await maybeCompactDndHistory(channelId, getDndSession(channelId));
        } else {
          await interaction.editReply("The session has begun~ (check the roll prompt below!)");
        }
      } catch (err) {
        console.error("Error starting /dnd session:", err);
        await endDndSession(channelId);
        await interaction.editReply("Ugh, something went wrong getting the story started. Try again?");
      }
      return;
    }

    if (sub === "end") {
      if (!hasDndSession(channelId)) {
        await interaction.reply({ content: "No active session here.", ephemeral: true });
        return;
      }
      if (pendingDndRolls.has(channelId)) {
        await interaction.reply({
          content: "There's a roll waiting — resolve it (🎲 button or `/dnd roll`) first, then run `/dnd end` again.",
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply();
      try {
        const closer = "[The session is ending now. Wrap up the story to a satisfying close.]";
        await appendDndTurn(channelId, "user", closer);
        const reply = await askAyameDnd(channelId, getDndSession(channelId), interaction.channel, interaction.user.username);
        if (!reply) {
          await interaction.editReply(
            "Hold on — one more roll needed before we wrap up! Resolve it, then run `/dnd end` again."
          );
          return;
        }
        await replyChunked(interaction, reply);
      } catch (err) {
        console.error("Error ending /dnd session:", err);
        await interaction.editReply("The session's over, though ahaha, I fumbled the ending a bit!");
      }
      await endDndSession(channelId);
      return;
    }

    if (sub === "roll") {
      const notation = interaction.options.getString("notation");
      const reason = interaction.options.getString("reason");

      if (pendingDndRolls.has(channelId)) {
        await interaction.deferReply({ ephemeral: true });
        const outcome = await resolvePendingDndRoll(channelId, interaction.user.username);
        if (!outcome.ok && outcome.reason === "not-yours") {
          await interaction.editReply("This isn't your roll to make~");
          return;
        }
        await interaction.editReply("Rolled!");
        return;
      }

      if (!notation) {
        await interaction.reply({
          content: "Give me a dice notation, e.g. `1d20+3` — or wait for a roll prompt to use this without one.",
          ephemeral: true,
        });
        return;
      }

      const result = rollDice(notation);
      if (hasDndSession(channelId)) {
        await appendDndTurn(
          channelId,
          "user",
          `[${interaction.user.username} manually rolled ${notation}${reason ? ` for ${reason}` : ""}: ${result}]`
        );
      }
      await interaction.reply(reason ? `**${reason}** — ${result}` : result);
      return;
    }

    if (sub === "how_to") {
      await interaction.reply(DND_HOW_TO_MESSAGE);
      return;
    }

    if (sub === "train") {
      if (!hasDndSession(channelId)) {
        await interaction.reply({ content: "No active session here.", ephemeral: true });
        return;
      }
      if (!hasCharacter(channelId, interaction.user.username)) {
        await interaction.reply({ content: "You don't have a character in this session yet~", ephemeral: true });
        return;
      }
      const stat = interaction.options.getString("stat", true);
      const points = interaction.options.getInteger("points", true);
      const result = await trainStat(channelId, interaction.user.username, stat, points);
      const ephemeral = result.startsWith("ERROR");
      await interaction.reply({ content: result.replace(/^(OK|ERROR): /, ""), ephemeral });
      return;
    }

    if (sub === "stat") {
      if (!hasDndSession(channelId)) {
        await interaction.reply({ content: "No active session here.", ephemeral: true });
        return;
      }
      const targetUser = interaction.options.getUser("player") ?? interaction.user;
      const sheet = getCharacterSheet(channelId, targetUser.username);
      if (!sheet) {
        const whose = targetUser.id === interaction.user.id ? "You don't" : "They don't";
        await interaction.reply({
          content: `${whose} have a character in this session yet~ Use \`/create_character\` first.`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({ embeds: [buildCharacterSheetEmbed(sheet, interaction.user.username)] });
      return;
    }
  }

  if (interaction.commandName === "create_character") {
    const channelId = interaction.channelId;
    if (!hasDndSession(channelId)) {
      await interaction.reply({
        content: "Start a `/dnd start` session first, then build your character!",
        ephemeral: true,
      });
      return;
    }
    if (hasCharacter(channelId, interaction.user.username)) {
      await interaction.reply({ content: "You already have a character in this session~", ephemeral: true });
      return;
    }

    const stats = {
      str: interaction.options.getInteger("str", true),
      dex: interaction.options.getInteger("dex", true),
      con: interaction.options.getInteger("con", true),
      int: interaction.options.getInteger("int", true),
      wis: interaction.options.getInteger("wis", true),
      cha: interaction.options.getInteger("cha", true),
    };
    const sum = Object.values(stats).reduce((total, value) => total + value, 0);
    if (sum !== 100) {
      await interaction.reply({
        content: `Your stats need to add up to exactly 100 (yours add up to ${sum}) — adjust and try again!`,
        ephemeral: true,
      });
      return;
    }
    if (Object.values(stats).some((value) => value < 0)) {
      await interaction.reply({ content: "Stats can't be negative~ try again.", ephemeral: true });
      return;
    }
    if (Object.values(stats).some((value) => value > STAT_CAP)) {
      await interaction.reply({
        content: `No single stat can go above ${STAT_CAP} — keeps every check meaningfully uncertain, even for a specialist. Adjust and try again!`,
        ephemeral: true,
      });
      return;
    }

    const name = interaction.options.getString("name");
    const characterClass = interaction.options.getString("class", true);
    const background = interaction.options.getString("background");
    await createCharacter(channelId, interaction.user.username, interaction.user.id, stats, name, characterClass, background);
    await interaction.reply(
      `Character created! ${name ? `**${name}** — ` : ""}${characterClass}, Lvl 1, ${10 + stats.con} HP, 50 gold to start.` +
        (background ? ` Backstory noted~` : "") +
        ` Good luck out there~`
    );
    return;
  }

  if (interaction.commandName === "chat") {
    const text = interaction.options.getString("message", true);
    const musicContext = isDM
      ? null
      : {
          distube,
          guildId: interaction.guildId,
          voiceChannel: interaction.member?.voice?.channel ?? null,
          textChannel: interaction.channel,
          member: interaction.member,
        };
    await interaction.deferReply();
    try {
      const reply = await askAyame(key, text, musicContext);
      await replyChunked(interaction, reply);
    } catch (err) {
      console.error("Error handling /chat:", err);
      await interaction.editReply(
        "Ah, hold on— something glitched out on my end (an error occurred). Try again in a moment!"
      );
    }
  }
});

await loadDndSessions();
client.login(DISCORD_TOKEN);
