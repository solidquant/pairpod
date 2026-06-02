import fs from "node:fs";
import path from "node:path";
import { type Bot, InlineKeyboard } from "grammy";
import { config as shared } from "./config.js";
import { botConfig } from "./config.js";
import { mdToTelegramHtml, escapeHtml } from "./tg-format.js";

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

const TG_LIMIT = 4000;

// Split near newline boundaries so a chunk doesn't cut through a line (and rarely through
// inline formatting) at the byte limit.
function chunks(s: string, limit: number): string[] {
  if (s.length <= limit) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// A chat-bridged session's reply, sent only to its owning chat (not broadcast). The session
// name is a bold header line so interleaved sessions are easy to tell apart; the body is
// rendered as Telegram HTML. On a parse rejection we resend as plain text so nothing is dropped.
export async function sendChatMessage(chatId: number, prefix: string, text: string): Promise<void> {
  if (!bot || !text) return;
  const header = `<b>${escapeHtml(prefix)}</b>`;
  for (const part of chunks(text, TG_LIMIT)) {
    try {
      await bot.api.sendMessage(chatId, `${header}\n${mdToTelegramHtml(part)}`, { parse_mode: "HTML" });
    } catch {
      try {
        await bot.api.sendMessage(chatId, `${prefix}\n${part}`);
      } catch {}
    }
  }
}

// Delete a notification we sent, on the mini-app's request when its "Open" button is tapped.
export async function dismissNotification(chatId: number, messageId: number): Promise<void> {
  if (!bot || !chatIds.has(chatId)) return;
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch {}
}
