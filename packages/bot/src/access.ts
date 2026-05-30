import { botConfig } from "./config.js";

export function hasAllowlist(): boolean {
  return botConfig.allowedUserIds.length > 0 || botConfig.allowedUsernames.length > 0;
}

export function isAllowed(userId?: number, username?: string): boolean {
  if (!hasAllowlist()) return true;
  if (userId !== undefined && botConfig.allowedUserIds.includes(userId)) return true;
  if (username && botConfig.allowedUsernames.includes(username.toLowerCase())) return true;
  return false;
}
