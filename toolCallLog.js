// toolCallLog.js
// Lightweight, fire-and-forget audit trail for every D&D tool call (dice rolls and all
// dndMechanics.js actions) — append-only, one JSON line per call, one file per channel under
// data/logs/. Exists so a "my gold/items don't add up" report can be traced to the exact tool
// calls that happened, instead of reverse-engineering it from narration text and final state
// alone — see the session-audit that motivated this (a shop purchase that got narrated but never
// actually charged, with nothing anywhere recording that the tool call was skipped).
// Never throws and never blocks gameplay on log I/O — a failed/slow log write must never affect
// a turn, so callers fire this without awaiting it.

import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(import.meta.dir, "data", "logs");
let dirReady = null;

function ensureDir() {
  if (!dirReady) dirReady = mkdir(LOG_DIR, { recursive: true });
  return dirReady;
}

export async function logToolCall(channelId, name, args, result) {
  if (!channelId) return;
  try {
    await ensureDir();
    const line = JSON.stringify({ t: new Date().toISOString(), name, args, result }) + "\n";
    await appendFile(path.join(LOG_DIR, `${channelId}.log`), line);
  } catch (err) {
    console.error("Failed to write tool-call log:", err?.message || err);
  }
}
