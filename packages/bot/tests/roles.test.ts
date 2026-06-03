import { test } from "node:test";
import assert from "node:assert/strict";
import { canWrite, canChat, canRead, isGrantRole, normalizeGrantRole, nextGrantRole } from "../src/roles.ts";

test("canWrite covers owner and writer-full only", () => {
  assert.equal(canWrite("owner"), true);
  assert.equal(canWrite("writer-full"), true);
  assert.equal(canWrite("writer-chat"), false);
  assert.equal(canWrite("reader"), false);
  assert.equal(canWrite(null), false);
});

test("canChat covers owner, writer-full, writer-chat", () => {
  assert.equal(canChat("owner"), true);
  assert.equal(canChat("writer-full"), true);
  assert.equal(canChat("writer-chat"), true);
  assert.equal(canChat("reader"), false);
  assert.equal(canChat(null), false);
});

test("canRead is true for any non-null role", () => {
  assert.equal(canRead("writer-chat"), true);
  assert.equal(canRead("reader"), true);
  assert.equal(canRead(null), false);
});

test("isGrantRole accepts only the three grantable roles", () => {
  assert.equal(isGrantRole("writer-full"), true);
  assert.equal(isGrantRole("writer-chat"), true);
  assert.equal(isGrantRole("reader"), true);
  assert.equal(isGrantRole("owner"), false);
  assert.equal(isGrantRole("writer"), false);
});

test("normalizeGrantRole accepts aliases", () => {
  assert.equal(normalizeGrantRole("full"), "writer-full");
  assert.equal(normalizeGrantRole("writer"), "writer-full");
  assert.equal(normalizeGrantRole("chat"), "writer-chat");
  assert.equal(normalizeGrantRole("WRITER-CHAT"), "writer-chat");
  assert.equal(normalizeGrantRole("read"), "reader");
  assert.equal(normalizeGrantRole("nope"), null);
});

test("nextGrantRole cycles reader → writer-chat → writer-full → reader", () => {
  assert.equal(nextGrantRole("reader"), "writer-chat");
  assert.equal(nextGrantRole("writer-chat"), "writer-full");
  assert.equal(nextGrantRole("writer-full"), "reader");
});
