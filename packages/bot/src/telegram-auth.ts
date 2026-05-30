import crypto from "node:crypto";

export interface InitDataResult {
  ok: boolean;
  userId?: number;
  username?: string;
  reason?: string;
}

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number
): InitDataResult {
  if (!initData) return { ok: false, reason: "empty" };
  if (!botToken) return { ok: false, reason: "no_token" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no_hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_hash" };
  }

  const authDate = Number(params.get("auth_date"));
  if (maxAgeSec > 0 && authDate > 0) {
    const ageSec = Date.now() / 1000 - authDate;
    if (ageSec > maxAgeSec) return { ok: false, reason: "expired" };
  }

  let userId: number | undefined;
  let username: string | undefined;
  try {
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number; username?: string };
    if (typeof user.id === "number") userId = user.id;
    if (typeof user.username === "string") username = user.username;
  } catch {}

  return { ok: true, userId, username };
}
