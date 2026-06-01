import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { consume } from "../src/spool-stream.ts";

test("consume emits whole lines and tracks byte offset", async () => {
  const s = new PassThrough();
  const lines: string[] = [];
  let lastOffset = 0;
  const p = consume(s, 0, (l) => lines.push(l), (n) => (lastOffset = n));

  const a = "alpha\n";
  const b = "beta\n";
  s.write(Buffer.from(a + b));
  s.end();

  assert.equal(await p, Buffer.byteLength(a + b));
  assert.equal(lastOffset, Buffer.byteLength(a + b));
  assert.deepEqual(lines, ["alpha", "beta"]);
});

test("consume reassembles a line split across chunks", async () => {
  const s = new PassThrough();
  const lines: string[] = [];
  const p = consume(s, 0, (l) => lines.push(l), () => {});

  const buf = Buffer.from("a-fairly-long-line\n");
  s.write(buf.subarray(0, 5));
  s.write(buf.subarray(5));
  s.end();

  await p;
  assert.deepEqual(lines, ["a-fairly-long-line"]);
});

test("consume leaves a torn trailing line unconsumed; offset only past complete lines", async () => {
  const s = new PassThrough();
  const lines: string[] = [];
  const full = "complete\n";
  const torn = '{"ts":2,"kind":"perm';
  const p = consume(s, 100, (l) => lines.push(l), () => {});

  s.write(Buffer.from(full + torn));
  s.end();

  assert.equal(await p, 100 + Buffer.byteLength(full));
  assert.deepEqual(lines, ["complete"]);
});

test("consume counts multibyte bytes, not characters", async () => {
  const s = new PassThrough();
  let lastOffset = 0;
  const line = "café→λ\n";
  const p = consume(s, 0, () => {}, (n) => (lastOffset = n));
  s.write(Buffer.from(line, "utf8"));
  s.end();
  await p;
  assert.equal(lastOffset, Buffer.byteLength(line, "utf8"));
  assert.notEqual(line.length, Buffer.byteLength(line, "utf8"));
});
