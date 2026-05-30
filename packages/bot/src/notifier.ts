import fs from "node:fs";
import path from "node:path";
import { type Bot, InlineKeyboard } from "grammy";
import { config as shared } from "./config.js";
import { botConfig } from "./config.js";

const STORE = path.join(path.dirname(shared.dbPath), "notify-chats.json");

let bot: Bot | null = null;
const chatIds = new Set<number>(load());

function load(): number[] {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")) as number[];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    fs.writeFileSync(STORE, JSON.stringify([...chatIds]));
  } catch {}
}

export function setNotifierBot(b: Bot): void {
  bot = b;
}

export function recordChat(id: number): void {
  if (!chatIds.has(id)) {
    chatIds.add(id);
    save();
  }
}

export async function pushNotification(
  text: string,
  pod?: string,
  session?: string
): Promise<void> {
  if (!bot) return;
  let reply_markup: InlineKeyboard | undefined;
  if (botConfig.miniappUrl && pod && session) {
    const url = `${botConfig.miniappUrl}/?pod=${encodeURIComponent(pod)}&session=${encodeURIComponent(session)}`;
    reply_markup = new InlineKeyboard().webApp(`▶ Open ${pod}:${session}`, url);
  }
  for (const id of chatIds) {
    try {
      await bot.api.sendMessage(id, text, reply_markup ? { reply_markup } : undefined);
    } catch {}
  }
}
