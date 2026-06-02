import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImage, hashName } from "../src/media-ingest.ts";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const gif = Buffer.from("GIF89a" + "....", "latin1");
const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "latin1")]);
const pdf = Buffer.from("%PDF-1.7", "latin1");

test("sniffImage recognizes the allowed formats by magic bytes", () => {
  assert.deepEqual(sniffImage(jpeg), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(sniffImage(png), { mime: "image/png", ext: "png" });
  assert.deepEqual(sniffImage(gif), { mime: "image/gif", ext: "gif" });
  assert.deepEqual(sniffImage(webp), { mime: "image/webp", ext: "webp" });
});

test("sniffImage rejects anything else", () => {
  assert.equal(sniffImage(pdf), null);
  assert.equal(sniffImage(Buffer.from([0x00, 0x01, 0x02])), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("hashName is content-addressed and stable", () => {
  const a = hashName(png, "png");
  const b = hashName(png, "png");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}\.png$/);
  assert.notEqual(hashName(jpeg, "jpg"), hashName(png, "png"));
});
