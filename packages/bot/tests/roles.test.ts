import { test } from "node:test";
import assert from "node:assert/strict";
import { canWrite, canRead, isGrantRole } from "../src/roles.ts";

test("canWrite covers owner and writer only", () => {
  assert.equal(canWrite("owner"), true);
  assert.equal(canWrite("writer"), true);
  assert.equal(canWrite("reader"), false);
  assert.equal(canWrite(null), false);
});

test("canRead is true for any non-null role", () => {
  assert.equal(canRead("owner"), true);
  assert.equal(canRead("writer"), true);
  assert.equal(canRead("reader"), true);
  assert.equal(canRead(null), false);
});

test("isGrantRole accepts only writer/reader", () => {
  assert.equal(isGrantRole("writer"), true);
  assert.equal(isGrantRole("reader"), true);
  assert.equal(isGrantRole("owner"), false);
  assert.equal(isGrantRole("nonsense"), false);
});
