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

export interface NotificationLink {
  pod: string;
  session: string;
  buttonLabel: string;
}

export async function pushNotification(text: string, link?: NotificationLink): Promise<void> {
  if (!bot) return;
  for (const id of chatIds) {
    try {
      const sent = await bot.api.sendMessage(id, text);
      if (botConfig.miniappUrl && link) {
        // cid+mid let the mini-app ask the bot to delete this very message once opened.
        const url =
          `${botConfig.miniappUrl}/?pod=${encodeURIComponent(link.pod)}` +
          `&session=${encodeURIComponent(link.session)}&cid=${id}&mid=${sent.message_id}`;
        const reply_markup = new InlineKeyboard().webApp(`▶ Open ${link.buttonLabel}`, url);
        await bot.api.editMessageReplyMarkup(id, sent.message_id, { reply_markup });
      }
    } catch {}
  }
}

// Delete a notification we sent, on the mini-app's request when its "Open" button is tapped.
export async function dismissNotification(chatId: number, messageId: number): Promise<void> {
  if (!bot || !chatIds.has(chatId)) return;
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch {}
}
