import { botConfig } from "./config.js";
import type { Role } from "./roles.js";
import { getUser, isOwnerRow, podRole, userCount, hasPendingFor } from "./users.js";

export function hasConfiguredOwners(): boolean {
  return botConfig.allowedUserIds.length > 0 || botConfig.allowedUsernames.length > 0;
}

// No env owners and an empty roster: a fresh/dev install with nothing configured. Everyone is
// treated as owner (matches the old "no allowlist → allow any" behavior) until owners exist.
export function openMode(): boolean {
  return !hasConfiguredOwners() && userCount() === 0;
}

function envOwner(userId?: number, username?: string): boolean {
  if (userId !== undefined && botConfig.allowedUserIds.includes(userId)) return true;
  if (username && botConfig.allowedUsernames.includes(username.toLowerCase())) return true;
  return false;
}

export function isOwner(userId?: number, username?: string): boolean {
  if (openMode()) return true;
  if (envOwner(userId, username)) return true;
  return userId !== undefined && isOwnerRow(userId);
}

// Coarse gate: is this user known to the bot at all? A pending-by-username invitee passes so
// their first message reaches the middleware that promotes them.
export function isAllowed(userId?: number, username?: string): boolean {
  if (openMode()) return true;
  if (isOwner(userId, username)) return true;
  if (userId !== undefined && getUser(userId)) return true;
  return hasPendingFor(username);
}

export function effectiveRole(userId: number | undefined, username: string | undefined, podId: string): Role | null {
  if (isOwner(userId, username)) return "owner";
  if (userId !== undefined) {
    const r = podRole(userId, podId);
    if (r) return r;
  }
  return null;
}
