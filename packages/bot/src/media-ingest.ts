import crypto from "node:crypto";

export interface ImageKind {
  mime: string;
  ext: string;
}

export type IngestResult =
  | { ok: true; name: string; kind: ImageKind; data: Buffer }
  | { ok: false; reason: "too_large" | "bad_type" | "fetch_failed" };

const MAX_BYTES = 20 * 1024 * 1024;

// Magic-byte sniff over the file header — trusted over any declared Content-Type. Only the
// formats Claude's vision accepts are allowed; everything else is rejected.
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return { mime: "image/png", ext: "png" };
  const head6 = buf.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") return { mime: "image/gif", ext: "gif" };
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

// Content-addressed name: same bytes → same file, so re-sends dedup on disk.
export function hashName(data: Buffer, ext: string): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 12) + "." + ext;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error("fetch_failed");
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("too_large");
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetch (3× retry with jitter — Telegram is flaky on cold files), enforce the size cap during
// the stream, then verify the type. Returns validated bytes + a content-hash filename.
export async function ingestImage(url: string): Promise<IngestResult> {
  let data: Buffer | null = null;
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    if (attempt) await sleep(200 * attempt + Math.floor(Math.random() * 200));
    try {
      data = await download(url);
    } catch (e) {
      if ((e as Error).message === "too_large") return { ok: false, reason: "too_large" };
    }
  }
  if (!data) return { ok: false, reason: "fetch_failed" };
  const kind = sniffImage(data);
  if (!kind) return { ok: false, reason: "bad_type" };
  return { ok: true, name: hashName(data, kind.ext), kind, data };
}
