// music.js
// YouTube playback via DisTube + youtubei.js, wired up with Ayame-flavored announcements.

import { DisTube, Events, DisTubeError, ExtractorPlugin, Song, RepeatMode } from "distube";
import { Innertube, Log } from "youtubei.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import ffmpegStaticPath from "ffmpeg-static";

// youtubei.js logs internal parser warnings (e.g. minor UI elements it can't fully parse)
// straight to the console by default — harmless noise, not something we act on.
Log.setLevel(Log.Level.NONE);

// Prefer a real system ffmpeg when one's on PATH (e.g. apt-installed in Docker) — it's a
// well-tested distro build. ffmpeg-static's bundled binary is a fallback for environments
// with no system ffmpeg at all (e.g. a bare Mac with no Homebrew); it works fine running
// natively, but its statically-linked build has been observed to segfault on real network
// streams under QEMU-emulated architectures (seen when cross-building/running amd64 images
// on Apple Silicon).
const ffmpegPath = (typeof Bun !== "undefined" && Bun.which("ffmpeg")) || ffmpegStaticPath;

// youtubei.js talks to YouTube's internal API directly (no external process, no shelling
// out) instead of yt-dlp's much heavier general-purpose extraction — this is what gets
// startup time down from yt-dlp's several-seconds-to-over-a-minute range to about a second.
// Session creation itself costs ~1s, so it's created once and reused for every song.
// "ANDROID_VR" is the client: the "WEB"/"ANDROID" clients increasingly get blocked without
// a PoToken (YouTube's newer proof-of-origin anti-bot check) and return no playable URL at
// all; ANDROID_VR consistently returns a direct, ready-to-use URL with no extra token needed
// (also what yt-dlp itself ended up falling back to for reliable extraction).
const YOUTUBE_CLIENT = "ANDROID_VR";
let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) innertubePromise = Innertube.create();
  return innertubePromise;
}

// Matches youtube.com/watch?v=ID, youtu.be/ID, /shorts/ID, /live/ID — deliberately ignores
// any accompanying &list=... (e.g. YouTube's auto-generated "Radio"/Mix playlists tacked
// onto a single video link): clicking one video should play that video, not the whole mix.
const VIDEO_ID_PATTERN = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{11})/;
const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

class YouTubeiPlugin extends ExtractorPlugin {
  validate(url) {
    return YOUTUBE_URL_PATTERN.test(url);
  }

  async resolve(url, options) {
    const videoId = url.match(VIDEO_ID_PATTERN)?.[1];
    if (!videoId) {
      throw new DisTubeError(
        "YOUTUBEI_ERROR",
        "That looks like a playlist-only link — paste a specific video link instead."
      );
    }
    return this.#songFromVideoId(videoId, options);
  }

  async searchSong(query, options) {
    const yt = await getInnertube();
    const results = await yt.search(query, { type: "video" });
    const videoId = results.videos?.[0]?.id ?? results.results?.find((r) => r.type === "Video")?.id;
    if (!videoId) return null;
    return this.#songFromVideoId(videoId, options).catch(() => null);
  }

  async getStreamURL(song) {
    if (song.stream.url) return song.stream.url;
    const videoId = song.url?.match(VIDEO_ID_PATTERN)?.[1] ?? song.id;
    if (!videoId) {
      throw new DisTubeError("YOUTUBEI_PLUGIN_INVALID_SONG", "Cannot get stream url from invalid song.");
    }
    return this.#chooseAudioUrl(videoId);
  }

  getRelatedSongs() {
    return [];
  }

  async #songFromVideoId(videoId, options) {
    const yt = await getInnertube();
    let info;
    try {
      info = await yt.getInfo(videoId, { client: YOUTUBE_CLIENT });
    } catch (err) {
      throw new DisTubeError("YOUTUBEI_ERROR", err.message || String(err));
    }
    const basic = info.basic_info;

    const song = new Song(
      {
        plugin: this,
        source: "youtube",
        playFromSource: true,
        id: basic.id,
        name: basic.title,
        url: `https://www.youtube.com/watch?v=${basic.id}`,
        isLive: basic.is_live,
        thumbnail: basic.thumbnail?.[basic.thumbnail.length - 1]?.url,
        duration: basic.is_live ? 0 : basic.duration,
        uploader: { name: basic.author, url: basic.channel?.url },
        views: basic.view_count,
        likes: basic.like_count,
        ageRestricted: false,
      },
      options
    );

    try {
      song.stream.url = await this.#chooseAudioUrl(videoId, info);
    } catch (err) {
      throw new DisTubeError("YOUTUBEI_ERROR", err.message || String(err));
    }
    return song;
  }

  async #chooseAudioUrl(videoId, info) {
    const yt = await getInnertube();
    const videoInfo = info ?? (await yt.getInfo(videoId, { client: YOUTUBE_CLIENT }));
    const format = videoInfo.chooseFormat({ type: "audio", quality: "best", client: YOUTUBE_CLIENT });
    return format.url || (await format.decipher(yt.session.player));
  }
}

const PROGRESS_BAR_LENGTH = 20;
// Discord's edit-message route is bucketed at ~5 requests/5s per channel (not the global
// 50 rps, which is shared across the whole bot) — 5s keeps this well under that (1 of 5
// slots/window) with headroom left for button-driven edits (pause/skip/etc.) landing in
// the same window.
const PROGRESS_UPDATE_INTERVAL_MS = 5_000;
const PREVIOUS_BUTTON_ID = "music:previous";
const PAUSE_RESUME_BUTTON_ID = "music:pauseresume";
const SKIP_BUTTON_ID = "music:skip";
const SHUFFLE_BUTTON_ID = "music:shuffle";
const REPEAT_BUTTON_ID = "music:repeat";

// guildId -> { message, intervalId }
const nowPlayingState = new Map();

function buildProgressBar(current, total) {
  if (!total || total <= 0) return "🔴 Live";
  const ratio = Math.min(Math.max(current / total, 0), 1);
  const filled = Math.round(ratio * PROGRESS_BAR_LENGTH);
  return "▬".repeat(filled) + "🔘" + "▬".repeat(Math.max(PROGRESS_BAR_LENGTH - filled, 0));
}

function buildNowPlayingEmbed(queue) {
  const song = queue.songs[0];
  return new EmbedBuilder()
    .setColor(0xf7b8d2)
    .setTitle(`🎶 ${song.name}`)
    .setURL(song.url ?? null)
    .setThumbnail(song.thumbnail ?? null)
    .setDescription(
      // queue.duration is the sum of every song in the queue, not just this one —
      // the current track's own duration is on the song itself.
      `${buildProgressBar(queue.currentTime, song.duration)}\n\`${queue.formattedCurrentTime} / ${song.formattedDuration}\``
    )
    .setFooter({ text: queue.paused ? "Paused~" : "Playing~" });
}

const REPEAT_BUTTON_EMOJI = {
  [RepeatMode.DISABLED]: "🔁",
  [RepeatMode.SONG]: "🔂",
  [RepeatMode.QUEUE]: "🔁",
};

function buildControlRow(queue) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREVIOUS_BUTTON_ID).setEmoji("⏮️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PAUSE_RESUME_BUTTON_ID)
      .setEmoji(queue.paused ? "▶️" : "⏸️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(SKIP_BUTTON_ID).setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(SHUFFLE_BUTTON_ID).setEmoji("🔀").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(REPEAT_BUTTON_ID)
      .setEmoji(REPEAT_BUTTON_EMOJI[queue.repeatMode])
      .setStyle(queue.repeatMode === RepeatMode.DISABLED ? ButtonStyle.Secondary : ButtonStyle.Success)
  );
}

// stops live-updating and disables the buttons on whatever now-playing message is
// currently tracked for this guild (called both before posting a new one, and when
// playback fully stops)
async function retireNowPlaying(guildId) {
  const state = nowPlayingState.get(guildId);
  if (!state) return;
  clearInterval(state.intervalId);
  nowPlayingState.delete(guildId);
  try {
    await state.message.edit({ components: [] });
  } catch {
    // message may already be gone; nothing to clean up
  }
}

async function sendNowPlaying(queue) {
  await retireNowPlaying(queue.id);
  if (!queue.textChannel) return;

  const message = await queue.textChannel.send({
    embeds: [buildNowPlayingEmbed(queue)],
    components: [buildControlRow(queue)],
  });

  const intervalId = setInterval(async () => {
    try {
      await message.edit({ embeds: [buildNowPlayingEmbed(queue)], components: [buildControlRow(queue)] });
    } catch {
      clearInterval(intervalId);
      nowPlayingState.delete(queue.id);
    }
  }, PROGRESS_UPDATE_INTERVAL_MS);

  nowPlayingState.set(queue.id, { message, intervalId });
}

export async function handleMusicButton(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "Nothing's playing anymore~", ephemeral: true });
    return;
  }

  try {
    if (interaction.customId === PREVIOUS_BUTTON_ID) {
      await queue.previous();
    } else if (interaction.customId === SKIP_BUTTON_ID) {
      await queue.skip();
    } else if (interaction.customId === PAUSE_RESUME_BUTTON_ID) {
      if (queue.paused) await queue.resume();
      else await queue.pause();
    } else if (interaction.customId === SHUFFLE_BUTTON_ID) {
      if (queue.songs.length < 2) {
        await interaction.reply({ content: "Not enough songs queued up to shuffle~", ephemeral: true });
        return;
      }
      await queue.shuffle();
    } else if (interaction.customId === REPEAT_BUTTON_ID) {
      queue.setRepeatMode();
    } else {
      return;
    }
  } catch (err) {
    console.error("Error handling music button:", err);
    await interaction.reply({ content: "Couldn't do that one, sorry~", ephemeral: true });
    return;
  }

  if (
    interaction.customId === PAUSE_RESUME_BUTTON_ID ||
    interaction.customId === SHUFFLE_BUTTON_ID ||
    interaction.customId === REPEAT_BUTTON_ID
  ) {
    // song didn't change, so refresh this same message in place
    await interaction.update({ embeds: [buildNowPlayingEmbed(queue)], components: [buildControlRow(queue)] });
  } else {
    // previous/skip trigger a PLAY_SONG event that retires this message and posts a
    // fresh one for the new song, so just ack the click
    await interaction.deferUpdate();
  }
}

export function createDistube(client) {
  const distube = new DisTube(client, {
    emitNewSongOnly: true,
    plugins: [new YouTubeiPlugin()],
    ffmpeg: { path: ffmpegPath },
  });

  distube.on(Events.PLAY_SONG, (queue) => {
    sendNowPlaying(queue);
  });

  distube.on(Events.ADD_SONG, (queue, song) => {
    if (queue.songs.length > 1) {
      queue.textChannel?.send(`Added **${song.name}** to the queue~`);
    }
  });

  distube.on(Events.FINISH, (queue) => {
    retireNowPlaying(queue.id);
    queue.textChannel?.send("That's the end of the queue! Ahaha, add more if you want~");
  });

  distube.on(Events.EMPTY, (queue) => {
    retireNowPlaying(queue.id);
    queue.textChannel?.send("Everyone left the voice channel, so I'm heading out too~");
  });

  distube.on(Events.DISCONNECT, (queue) => {
    retireNowPlaying(queue.id);
    queue.textChannel?.send("Alright, I'm out of the voice channel now. Call me back anytime~");
  });

  distube.on(Events.ERROR, (error, queue) => {
    console.error("DisTube error:", error);
    if (queue) retireNowPlaying(queue.id);
    queue?.textChannel?.send("Ugh, something went wrong with that song. Try another?");
  });

  return distube;
}

function formatQueueList(queue) {
  const lines = queue.songs
    .slice(0, 10)
    .map((song, i) => `${i === 0 ? "▶️" : `${i}.`} ${song.name} \`${song.formattedDuration}\``)
    .join("\n");
  const remaining = queue.songs.length - 10;
  return remaining > 0 ? `${lines}\n...and ${remaining} more~` : lines;
}

export async function handlePlay(distube, interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: "You need to be in a voice channel first, hehe~", ephemeral: true });
    return;
  }

  const query = interaction.options.getString("query", true);
  // ack immediately: yt-dlp extraction can take a while, and the actual "now playing"
  // confirmation comes separately from the PLAY_SONG/ADD_SONG event listeners above
  await interaction.reply(`Okay, looking that up now~ "${query}"`);

  try {
    await distube.play(voiceChannel, query, {
      textChannel: interaction.channel,
      member: interaction.member,
    });
  } catch (err) {
    console.error("Error handling /play:", err);
    await interaction.followUp("Hmm, couldn't play that one. Try a different link or search?");
  }
}

export async function handleSkip(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "Nothing's playing right now~", ephemeral: true });
    return;
  }
  try {
    await queue.skip();
    await interaction.reply("Skipped~ onto the next one!");
  } catch {
    await interaction.reply({ content: "That's the last song, can't skip past nothing!", ephemeral: true });
  }
}

export async function handleQueue(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue || queue.songs.length === 0) {
    await interaction.reply({ content: "Queue's empty~ nothing playing.", ephemeral: true });
    return;
  }
  await interaction.reply(formatQueueList(queue));
}

export async function handleRemove(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "Queue's empty~ nothing to remove.", ephemeral: true });
    return;
  }

  const position = interaction.options.getInteger("position", true);
  if (position === 0) {
    await interaction.reply({
      content: "That one's already playing~ use /skip instead of /remove for that.",
      ephemeral: true,
    });
    return;
  }
  if (position < 1 || position >= queue.songs.length) {
    await interaction.reply({ content: "There's no song at that position~", ephemeral: true });
    return;
  }

  const [removed] = queue.songs.splice(position, 1);
  await interaction.reply(`Poof! Removed **${removed.name}** from the queue~`);
}

export async function handleJump(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "Nothing's playing right now~", ephemeral: true });
    return;
  }

  const position = interaction.options.getInteger("position", true);
  try {
    await queue.jump(position);
    await interaction.reply("Jumping ahead~ hold on!");
  } catch (err) {
    console.error("Error handling /jump:", err);
    await interaction.reply({ content: "There's no song at that position~", ephemeral: true });
  }
}

export async function handleShuffle(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue || queue.songs.length < 2) {
    await interaction.reply({ content: "Not enough songs queued up to shuffle~", ephemeral: true });
    return;
  }
  await queue.shuffle();
  await interaction.reply("Shuffled the queue~ 🔀");
}

const REPEAT_MODE_REPLIES = {
  [RepeatMode.DISABLED]: "Repeat's off now~",
  [RepeatMode.SONG]: "Repeating this song on loop~ 🔂",
  [RepeatMode.QUEUE]: "Repeating the whole queue~ 🔁",
};

export async function handleRepeat(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "Nothing's playing right now~", ephemeral: true });
    return;
  }
  // calling with no argument makes DisTube itself cycle DISABLED -> SONG -> QUEUE -> DISABLED
  const mode = queue.setRepeatMode();
  await interaction.reply(REPEAT_MODE_REPLIES[mode]);
}

export async function handlePause(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "Nothing's playing~", ephemeral: true });
    return;
  }
  await queue.pause();
  await interaction.reply("Paused! Say the word when you want more~");
}

export async function handleResume(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "Nothing's playing~", ephemeral: true });
    return;
  }
  await queue.resume();
  await interaction.reply("And we're back~ ♪");
}

export async function handleLeave(distube, interaction) {
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) {
    await interaction.reply({ content: "I'm not even in a voice channel, hehe~", ephemeral: true });
    return;
  }
  // queue.stop() only stops the audio player, it doesn't destroy the voice connection;
  // voices.leave() does that (and cascades into the same cleanup via the DISCONNECT event)
  distube.voices.leave(interaction.guildId);
  await interaction.reply("Alright, heading out~ Bye bye!");
}

// Function-calling tool for the chat persona (see askAyame in index.js): lets Ayame control
// music playback from plain conversation ("ojou play x") instead of requiring slash commands.
// Each declaration is described the way it should be *narrated*, since the model's follow-up
// reply to the user is built directly from whatever string these actions return.
export const MUSIC_FUNCTION_DECLARATIONS = [
  {
    name: "play_music",
    description:
      "Play a song in the user's current voice channel, or add it to the queue if something's " +
      "already playing. Call this whenever the user clearly asks to play/queue a specific song, " +
      "artist, or YouTube link — including casual phrasing like 'play <song>' or 'queue up " +
      "<song>'. Do NOT call this for unrelated uses of 'play'/'playing' — e.g. talking about " +
      "playing a video game, sport, or match, or 'play' used figuratively. Only call it when " +
      "there's an actual song/artist/link to queue.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song title, artist + title, or a YouTube URL." },
      },
      required: ["query"],
    },
  },
  {
    name: "skip_song",
    description: "Skip the currently playing song and move to the next one in the queue.",
  },
  {
    name: "pause_music",
    description: "Pause the current playback.",
  },
  {
    name: "resume_music",
    description: "Resume playback after it's been paused.",
  },
  {
    name: "shuffle_queue",
    description: "Shuffle the order of the upcoming songs in the queue.",
  },
  {
    name: "toggle_repeat",
    description:
      "Cycle the repeat mode one step: off -> repeat the current song -> repeat the whole " +
      "queue -> off. Call this when the user asks to turn repeat/loop on, off, or change it, " +
      "even if they don't specify which of the two repeat modes they want.",
  },
  {
    name: "get_queue",
    description: "List what's currently playing and what's up next in the queue.",
  },
  {
    name: "leave_voice",
    description: "Stop playback and leave the voice channel.",
  },
];

const MUSIC_ACTION_NAMES = new Set(MUSIC_FUNCTION_DECLARATIONS.map((decl) => decl.name));

export function isMusicAction(name) {
  return MUSIC_ACTION_NAMES.has(name);
}

// Executes a music action requested by the chat model and reports back a plain-text result —
// NOT sent to the user directly, but fed back to the model as a function response so it can
// narrate the outcome in character. `ctx` is { distube, guildId, voiceChannel, textChannel, member }.
export async function runMusicAction(name, args, ctx) {
  const { distube, guildId } = ctx;
  const queue = distube.getQueue(guildId);

  switch (name) {
    case "play_music": {
      const query = typeof args?.query === "string" ? args.query : null;
      if (!query) return "ERROR: no song was specified.";
      if (!ctx.voiceChannel) return "ERROR: the user isn't in a voice channel, so nothing can be played.";
      try {
        await distube.play(ctx.voiceChannel, query, { textChannel: ctx.textChannel, member: ctx.member });
        return `OK: queued "${query}".`;
      } catch (err) {
        return `ERROR: couldn't play "${query}" (${err.message || err}).`;
      }
    }
    case "skip_song": {
      if (!queue) return "ERROR: nothing is playing right now.";
      try {
        await queue.skip();
        return "OK: skipped to the next song.";
      } catch {
        return "ERROR: that's the last song in the queue, there's nothing to skip to.";
      }
    }
    case "pause_music": {
      if (!queue) return "ERROR: nothing is playing right now.";
      if (queue.paused) return "OK: playback was already paused.";
      await queue.pause();
      return "OK: paused playback.";
    }
    case "resume_music": {
      if (!queue) return "ERROR: nothing is playing right now.";
      if (!queue.paused) return "OK: playback was already going.";
      await queue.resume();
      return "OK: resumed playback.";
    }
    case "shuffle_queue": {
      if (!queue || queue.songs.length < 2) return "ERROR: not enough songs queued up to shuffle.";
      await queue.shuffle();
      return "OK: shuffled the queue.";
    }
    case "toggle_repeat": {
      if (!queue) return "ERROR: nothing is playing right now.";
      const mode = queue.setRepeatMode();
      const label =
        mode === RepeatMode.SONG ? "repeat current song" : mode === RepeatMode.QUEUE ? "repeat whole queue" : "off";
      return `OK: repeat mode is now "${label}".`;
    }
    case "get_queue": {
      if (!queue || queue.songs.length === 0) return "OK: the queue is empty, nothing is playing.";
      return `OK:\n${formatQueueList(queue)}`;
    }
    case "leave_voice": {
      if (!queue) return "ERROR: not currently in a voice channel.";
      distube.voices.leave(guildId);
      return "OK: left the voice channel.";
    }
    default:
      return "ERROR: unknown music action.";
  }
}
