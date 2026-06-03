import { getDb } from "./db.js";
import { botConfig } from "./config.js";
import type { GrantRole } from "./roles.js";

const now = (): string => new Date().toISOString();
const lc = (u: string): string => u.trim().replace(/^@/, "").toLowerCase();

export interface UserRow {
  userId: number;
  username: string | null;
  isOwner: boolean;
}

export interface AccessEntry {
  userId?: number;
  username: string | null;
  role: string;
  pending: boolean;
}

function rowToUser(r: { userId: number; username: string | null; isOwner: number } | undefined): UserRow | undefined {
  return r ? { userId: r.userId, username: r.username, isOwner: !!r.isOwner } : undefined;
}

export function getUser(userId: number): UserRow | undefined {
  return rowToUser(
    getDb()
      .prepare("SELECT user_id AS userId, username, is_owner AS isOwner FROM users WHERE user_id = ?")
      .get(userId) as never
  );
}

export function getUserByUsername(username: string): UserRow | undefined {
  return rowToUser(
    getDb()
      .prepare("SELECT user_id AS userId, username, is_owner AS isOwner FROM users WHERE username = ? COLLATE NOCASE")
      .get(lc(username)) as never
  );
}

export function userCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function ownerCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE is_owner = 1").get() as { n: number }).n;
}

export function isOwnerRow(userId: number): boolean {
  return !!getUser(userId)?.isOwner;
}

export function podRole(userId: number, podId: string): GrantRole | undefined {
  const r = getDb()
    .prepare("SELECT role FROM pod_access WHERE user_id = ? AND pod_id = ?")
    .get(userId, podId) as { role: GrantRole } | undefined;
  return r?.role;
}

export function grantedPodIds(userId: number): Set<string> {
  const rows = getDb().prepare("SELECT pod_id FROM pod_access WHERE user_id = ?").all(userId) as {
    pod_id: string;
  }[];
  return new Set(rows.map((r) => r.pod_id));
}

export function hasPendingFor(username?: string): boolean {
  if (!username) return false;
  return !!getDb()
    .prepare("SELECT 1 FROM pending_invites WHERE username = ? COLLATE NOCASE LIMIT 1")
    .get(lc(username));
}

function touchUser(userId: number, username?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO users (user_id, username, is_owner, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = COALESCE(excluded.username, users.username), updated_at = excluded.updated_at`
    )
    .run(userId, username ? lc(username) : null, now(), now());
}

export function setOwner(userId: number, username?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO users (user_id, username, is_owner, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         is_owner = 1, username = COALESCE(excluded.username, users.username), updated_at = excluded.updated_at`
    )
    .run(userId, username ? lc(username) : null, now(), now());
}

function writeAccess(userId: number, podId: string, role: GrantRole, by: number | null): void {
  getDb()
    .prepare(
      `INSERT INTO pod_access (user_id, pod_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, pod_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`
    )
    .run(userId, podId, role, by, now());
}

// Grant by numeric id or @username. An unknown username is parked in pending_invites
// and applied when that user first messages the bot (promoteInvitee).
export function grant(target: string, podId: string, role: GrantRole, by: number): { pending: boolean } {
  const t = target.trim();
  if (/^\d+$/.test(t)) {
    const uid = parseInt(t, 10);
    touchUser(uid);
    writeAccess(uid, podId, role, by);
    return { pending: false };
  }
  const existing = getUserByUsername(t);
  if (existing) {
    writeAccess(existing.userId, podId, role, by);
    return { pending: false };
  }
  getDb()
    .prepare(
      `INSERT INTO pending_invites (username, pod_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(username, pod_id) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by`
    )
    .run(lc(t), podId, role, by, now());
  return { pending: true };
}

export function revokeAccess(userId: number, podId: string): void {
  getDb().prepare("DELETE FROM pod_access WHERE user_id = ? AND pod_id = ?").run(userId, podId);
}

export function revokePending(username: string, podId: string): void {
  getDb()
    .prepare("DELETE FROM pending_invites WHERE username = ? COLLATE NOCASE AND pod_id = ?")
    .run(lc(username), podId);
}

export function listAccess(podId: string): AccessEntry[] {
  const db = getDb();
  const resolved = db
    .prepare(
      `SELECT pa.user_id AS userId, u.username AS username, pa.role AS role
       FROM pod_access pa LEFT JOIN users u ON u.user_id = pa.user_id WHERE pa.pod_id = ? ORDER BY pa.created_at ASC`
    )
    .all(podId) as { userId: number; username: string | null; role: string }[];
  const pending = db
    .prepare("SELECT username, role FROM pending_invites WHERE pod_id = ? AND pod_id != '' ORDER BY created_at ASC")
    .all(podId) as { username: string; role: string }[];
  return [
    ...resolved.map((r) => ({ userId: r.userId, username: r.username, role: r.role, pending: false })),
    ...pending.map((r) => ({ username: r.username, role: r.role, pending: true })),
  ];
}

export function clearPodAccess(podId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM pod_access WHERE pod_id = ?").run(podId);
  db.prepare("DELETE FROM pending_invites WHERE pod_id = ?").run(podId);
}

// On a user's message: refresh a known user's handle, and apply any pending grants/owner
// keyed on their @username (which we couldn't resolve to an id until now). Returns a
// human-readable list of what was applied, for a one-time confirmation reply.
export function promoteInvitee(userId: number, username?: string): string[] {
  const db = getDb();
  const uname = username ? lc(username) : null;
  if (getUser(userId) && uname) {
    db.prepare("UPDATE users SET username = ?, updated_at = ? WHERE user_id = ?").run(uname, now(), userId);
  }
  if (!uname) return [];

  const rows = db
    .prepare("SELECT pod_id AS podId, role FROM pending_invites WHERE username = ? COLLATE NOCASE")
    .all(uname) as { podId: string; role: string }[];
  if (!rows.length) return [];

  const applied: string[] = [];
  for (const r of rows) {
    if (r.podId === "" && r.role === "owner") {
      setOwner(userId, uname);
      applied.push("owner");
    } else {
      touchUser(userId, uname);
      writeAccess(userId, r.podId, r.role as GrantRole, null);
      applied.push(`${r.role} on ${r.podId}`);
    }
  }
  db.prepare("DELETE FROM pending_invites WHERE username = ? COLLATE NOCASE").run(uname);
  return applied;
}

// Seed owners from the env allowlist. Ids become owner rows; usernames we can't resolve to
// an id yet are parked as pending owner grants (pod_id '') and promoted on first message.
export function bootstrapOwners(): void {
  const db = getDb();
  for (const id of botConfig.allowedUserIds) setOwner(id);
  for (const uname of botConfig.allowedUsernames) {
    const existing = getUserByUsername(uname);
    if (existing) {
      setOwner(existing.userId, uname);
    } else {
      db.prepare(
        `INSERT INTO pending_invites (username, pod_id, role, invited_by, created_at)
         VALUES (?, '', 'owner', NULL, ?) ON CONFLICT(username, pod_id) DO NOTHING`
      ).run(lc(uname), now());
    }
  }
}
