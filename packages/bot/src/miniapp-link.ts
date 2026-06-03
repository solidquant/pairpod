import { botConfig } from "./config.js";

let botUsername = "";

export function setBotUsername(u: string): void {
  botUsername = (u || "").replace(/^@/, "");
}

export function deepLinkReady(): boolean {
  return Boolean(botUsername && (botConfig.appShortName || botConfig.mainMiniApp));
}

// Direct-link mini app launch — valid as a url button in group chats (web_app buttons are not).
// The target rides in startapp as base64url of "pod/session" (or "pod/session/cid/mid"); the mini
// app reads it from initData.start_param. Uses the /newapp short name when set, else the bot's
// Main Mini App. Null when neither is configured, so the caller falls back to the web_app link.
export function deepLink(podId: string, sessionId: string, cid?: number, mid?: number): string | null {
  if (!deepLinkReady()) return null;
  const parts = [podId, sessionId];
  if (cid !== undefined && mid !== undefined) parts.push(String(cid), String(mid));
  const payload = Buffer.from(parts.join("/")).toString("base64url");
  const base = botConfig.appShortName
    ? `https://t.me/${botUsername}/${botConfig.appShortName}`
    : `https://t.me/${botUsername}`;
  return `${base}?startapp=${payload}`;
}

// Legacy private-chat web_app URL (invalid as an inline button in groups).
export function webAppUrl(podId: string, sessionId: string, cid?: number, mid?: number): string | null {
  if (!botConfig.miniappUrl) return null;
  let u = `${botConfig.miniappUrl}/?pod=${encodeURIComponent(podId)}&session=${encodeURIComponent(sessionId)}`;
  if (cid !== undefined && mid !== undefined) u += `&cid=${cid}&mid=${mid}`;
  return u;
}
