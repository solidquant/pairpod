import { botConfig } from "./config.js";

let botUsername = "";

export function setBotUsername(u: string): void {
  botUsername = (u || "").replace(/^@/, "");
}

export function deepLinkReady(): boolean {
  return Boolean(botUsername && botConfig.appShortName);
}

// Direct-link mini app launch — valid as a url button in group chats (web_app buttons are not).
// The target rides in startapp as base64url of "pod/session" (or "pod/session/cid/mid"); the mini
// app reads it from initData.start_param. Null when the app short name / username aren't set, so
// the caller falls back to the private-chat web_app link.
export function deepLink(podId: string, sessionId: string, cid?: number, mid?: number): string | null {
  if (!deepLinkReady()) return null;
  const parts = [podId, sessionId];
  if (cid !== undefined && mid !== undefined) parts.push(String(cid), String(mid));
  const payload = Buffer.from(parts.join("/")).toString("base64url");
  return `https://t.me/${botUsername}/${botConfig.appShortName}?startapp=${payload}`;
}

// Legacy private-chat web_app URL (invalid as an inline button in groups).
export function webAppUrl(podId: string, sessionId: string, cid?: number, mid?: number): string | null {
  if (!botConfig.miniappUrl) return null;
  let u = `${botConfig.miniappUrl}/?pod=${encodeURIComponent(podId)}&session=${encodeURIComponent(sessionId)}`;
  if (cid !== undefined && mid !== undefined) u += `&cid=${cid}&mid=${mid}`;
  return u;
}
