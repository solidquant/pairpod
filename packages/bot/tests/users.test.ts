import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point all state at a throwaway dir and clear any ambient owner config before the modules
// (which read these at import time) load. Dynamic import so this runs first.
process.env.PAIRPOD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pairpod-users-"));
delete process.env.TELEGRAM_ALLOWED_USER_IDS;
delete process.env.TELEGRAM_ALLOWED_USERNAMES;
delete process.env.TELEGRAM_BOT_TOKEN;

const { getDb } = await import("../src/db.ts");
const users = await import("../src/users.ts");
const access = await import("../src/access.ts");
const { canWrite } = await import("../src/roles.ts");

getDb();

test("open mode until an owner exists", () => {
  assert.equal(access.openMode(), true);
  assert.equal(access.isAllowed(999, "nobody"), true);
  assert.equal(access.isOwner(999, "nobody"), true);
});

test("setOwner closes open mode and flags the owner", () => {
  users.setOwner(1, "boss");
  assert.equal(users.ownerCount(), 1);
  assert.equal(access.openMode(), false);
  assert.equal(access.isOwner(1), true);
  assert.equal(access.isOwner(2, "rando"), false);
  assert.equal(access.isAllowed(2, "rando"), false);
});

test("grant by unknown username is pending until promotion", () => {
  const res = users.grant("@alice", "pod-1", "reader", 1);
  assert.equal(res.pending, true);
  assert.equal(access.effectiveRole(2, "alice", "pod-1"), null);
  assert.equal(access.isAllowed(undefined, "alice"), true); // pending lets the first message in
  const applied = users.promoteInvitee(2, "alice");
  assert.deepEqual(applied, ["reader on pod-1"]);
  assert.equal(access.effectiveRole(2, "alice", "pod-1"), "reader");
  assert.equal(canWrite(access.effectiveRole(2, "alice", "pod-1")), false);
});

test("re-grant to a now-known user updates the role immediately", () => {
  const res = users.grant("@alice", "pod-1", "writer", 1);
  assert.equal(res.pending, false);
  assert.equal(access.effectiveRole(2, "alice", "pod-1"), "writer");
  assert.equal(canWrite(access.effectiveRole(2, "alice", "pod-1")), true);
});

test("grant by numeric id, then revoke", () => {
  users.grant("3", "pod-2", "writer", 1);
  assert.equal(users.podRole(3, "pod-2"), "writer");
  users.revokeAccess(3, "pod-2");
  assert.equal(users.podRole(3, "pod-2"), undefined);
  assert.equal(access.effectiveRole(3, undefined, "pod-2"), null);
});

test("owner sees every pod regardless of grants", () => {
  assert.equal(access.effectiveRole(1, "boss", "pod-1"), "owner");
  assert.equal(access.effectiveRole(1, "boss", "pod-anything"), "owner");
});

test("clearPodAccess removes resolved and pending grants", () => {
  users.grant("@carol", "pod-9", "reader", 1);
  users.grant("3", "pod-9", "writer", 1);
  assert.equal(users.listAccess("pod-9").length, 2);
  users.clearPodAccess("pod-9");
  assert.deepEqual(users.listAccess("pod-9"), []);
});

test("a pending owner invite promotes to owner", () => {
  getDb()
    .prepare(
      "INSERT INTO pending_invites (username, pod_id, role, invited_by, created_at) VALUES ('dave', '', 'owner', NULL, 't')"
    )
    .run();
  const applied = users.promoteInvitee(7, "dave");
  assert.deepEqual(applied, ["owner"]);
  assert.equal(access.isOwner(7), true);
});
