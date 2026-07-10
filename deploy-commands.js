// deploy-commands.js
// Registers the bot's slash commands with Discord.
// Run this once (and again any time the command definitions change):
//   bun deploy-commands.js
//
// If DISCORD_GUILD_ID is set in .env, commands are registered to that guild only
// (updates instantly — best for testing). Otherwise they're registered globally
// (can take up to ~1 hour to propagate).

import "dotenv/config";
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";

const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");

const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Chat with Ayame")
    .addStringOption((option) =>
      option.setName("message").setDescription("What do you want to say?").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear Ayame's memory of this conversation"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Turn off active chat mode in this channel (she'll wait for a mention again)"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Bulk-delete recent messages in this channel")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("How many recent messages to delete (1-100, default 20)")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a YouTube song (or add it to the queue)")
    .addStringOption((option) =>
      option.setName("query").setDescription("A YouTube URL or search terms").setRequired(true)
    )
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current song queue")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a song from the queue by its position (see /queue)")
    .addIntegerOption((option) =>
      option.setName("position").setDescription("Queue position to remove, e.g. 2").setMinValue(1).setRequired(true)
    )
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("jump")
    .setDescription("Jump straight to a song in the queue by its position (see /queue)")
    .addIntegerOption((option) =>
      option.setName("position").setDescription("Queue position to jump to, e.g. 3").setMinValue(1).setRequired(true)
    )
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause playback")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume playback")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Stop playback and leave the voice channel")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the current queue")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("repeat")
    .setDescription("Cycle repeat mode: off -> repeat song -> repeat queue -> off")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("dnd")
    .setDescription("Run a tabletop D&D one-shot with Ayame as your Game Master")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Start a new D&D session in this channel")
        .addStringOption((option) =>
          option.setName("theme").setDescription("Optional theme, e.g. 'haunted mansion'").setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName("end").setDescription("End the current D&D session in this channel"))
    .addSubcommand((sub) =>
      sub
        .setName("roll")
        .setDescription("Manually roll dice, or resolve a pending 🎲 roll prompt if one's waiting on you")
        .addStringOption((option) =>
          option
            .setName("notation")
            .setDescription("Dice notation, e.g. 1d20+3 (not needed if resolving a pending roll prompt)")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("reason").setDescription("What the roll is for").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("how_to").setDescription("Step-by-step guide for starting a session and joining in")
    )
    .addSubcommand((sub) =>
      sub
        .setName("train")
        .setDescription("Spend a level-up stat point (1 per level, capped at 40 per stat)")
        .addStringOption((option) =>
          option
            .setName("stat")
            .setDescription("Which stat to raise")
            .setRequired(true)
            .addChoices(
              { name: "Strength", value: "str" },
              { name: "Dexterity", value: "dex" },
              { name: "Constitution", value: "con" },
              { name: "Intelligence", value: "int" },
              { name: "Wisdom", value: "wis" },
              { name: "Charisma", value: "cha" }
            )
        )
        .addIntegerOption((option) =>
          option.setName("points").setDescription("How many unspent points to spend").setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("stat")
        .setDescription("Show a character sheet card — yours, or another player's")
        .addUserOption((option) =>
          option.setName("player").setDescription("Whose character to show (defaults to you)").setRequired(false)
        )
    ),
  new SlashCommandBuilder()
    .setName("create_character")
    .setDescription("Create your D&D character for the active session (100 points to split across 6 stats, 40 max each)")
    .addStringOption((option) =>
      option
        .setName("class")
        .setDescription("Your class/concept — go wild, any fantasy or sci-fi flavor you want")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(50)
    )
    .addIntegerOption((option) =>
      option.setName("str").setDescription("Strength (max 40)").setRequired(true).setMinValue(0).setMaxValue(40)
    )
    .addIntegerOption((option) =>
      option.setName("dex").setDescription("Dexterity (max 40)").setRequired(true).setMinValue(0).setMaxValue(40)
    )
    .addIntegerOption((option) =>
      option.setName("con").setDescription("Constitution (max 40)").setRequired(true).setMinValue(0).setMaxValue(40)
    )
    .addIntegerOption((option) =>
      option.setName("int").setDescription("Intelligence (max 40)").setRequired(true).setMinValue(0).setMaxValue(40)
    )
    .addIntegerOption((option) =>
      option.setName("wis").setDescription("Wisdom (max 40)").setRequired(true).setMinValue(0).setMaxValue(40)
    )
    .addIntegerOption((option) =>
      option.setName("cha").setDescription("Charisma (max 40)").setRequired(true).setMinValue(0).setMaxValue(40)
    )
    .addStringOption((option) =>
      option.setName("name").setDescription("Character name (optional flavor)").setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("background")
        .setDescription("Optional: a bit of backstory, a hobby, or a small skill your character has")
        .setRequired(false)
        .setMaxLength(300)
    ),
].map((command) => command.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);

const appRes = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
  headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
});
if (!appRes.ok) {
  throw new Error(`Failed to fetch application info: ${appRes.status} ${await appRes.text()}`);
}
const { id: clientId } = await appRes.json();

const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(clientId, DISCORD_GUILD_ID)
  : Routes.applicationCommands(clientId);

const result = await rest.put(route, { body: commands });
console.log(
  `Registered ${result.length} slash command(s) ${
    DISCORD_GUILD_ID ? `to guild ${DISCORD_GUILD_ID}` : "globally"
  }.`
);
