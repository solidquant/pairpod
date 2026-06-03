import { Bot, InlineKeyboard, type Context } from "grammy";
import { run } from "@grammyjs/runner";
import { botConfig } from "./config.js";
import { updateEnv } from "./env.js";
import { isAllowed, isOwner, effectiveRole, openMode } from "./access.js";
import { canWrite, isGrantRole } from "./roles.js";
import { promoteInvitee, grant, revokeAccess, revokePending, listAccess } from "./users.js";
import { setNotifierBot, recordChat } from "./notifier.js";
import {
  listPods,
  getPod,
  createPod,
  createLocalPod,
  deletePod,
  createSession,
  deleteSession,
  testPod,
  setPodLabel,
  setSessionLabel,
  sendToSession,
  getPodRow,
  isGrantablePod,
  type SessionMode,
  type PodView,
} from "./store.js";
import {
  resolveHandle,
  getChatSession,
  listChatSessions,
  setFocus,
  getFocus,
  normalizeHandle,
} from "./chat-store.js";
import { ingestImage } from "./media-ingest.js";
import { writeToPod } from "./media-transport.js";
import { setBotUsername, deepLink, webAppUrl } from "./miniapp-link.js";

// chat id -> a pending rename target; the user's next text message becomes the name.
const pendingRename = new Map<number, { podId: string; sessionId?: string }>();
// chat id -> a pod awaiting a handle; the user's next text message names a new chat session.
const pendingNewChat = new Map<number, { podId: string }>();
// chat id -> a pod awaiting an access grant; the user's next text message is "@user writer|reader".
const pendingGrant = new Map<number, { podId: string }>();

// Pin env owners by numeric id (sturdier than @handle, which Telegram lets people reassign),
// and apply any grants/owner that were issued to this user's @username before their id was known.
async function maybePromoteInvitee(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from?.id) return;

  if (from.username && botConfig.allowedUsernames.includes(from.username.toLowerCase()) && !botConfig.allowedUserIds.includes(from.id)) {
    botConfig.allowedUserIds.push(from.id);
    try {
      updateEnv({ TELEGRAM_ALLOWED_USER_IDS: botConfig.allowedUserIds.join(",") });
    } catch (e) {
      console.error("failed to persist pinned user id", e);
    }
  }

  const applied = promoteInvitee(from.id, from.username);
  if (applied.length) await ctx.reply(`🔑 Access granted: ${applied.join(", ")}.`);
}

async function requireOwner(ctx: Context): Promise<boolean> {
  if (isOwner(ctx.from?.id, ctx.from?.username)) return true;
  await ctx.answerCallbackQuery({ text: "Owner only.", show_alert: true });
  return false;
}

async function requireWrite(ctx: Context, podId: string): Promise<boolean> {
  if (canWrite(effectiveRole(ctx.from?.id, ctx.from?.username, podId))) return true;
  await ctx.answerCallbackQuery({ text: "You don't have write access to this pod.", show_alert: true });
  return false;
}

// Render a terminal-open button: a direct-link mini app (url button — valid in groups) when the
// app short name is configured, else the legacy private-chat web_app button. Returns false when
// no mini app URL is configured at all (caller shows a "set MINIAPP_URL" hint).
function addOpenButton(kb: InlineKeyboard, label: string, podId: string, sessionId: string): boolean {
  const dl = deepLink(podId, sessionId);
  if (dl) {
    kb.url(label, dl);
    return true;
  }
  const wa = webAppUrl(podId, sessionId);
  if (wa) {
    kb.webApp(label, wa);
    return true;
  }
  return false;
}

// SSH endpoint forms (ssh.html) aren't migrated to a deep link; their web_app button only works
// in private chats. In a group, point the user to a DM instead of crashing the keyboard.
function addSshFormButton(kb: InlineKeyboard, label: string, isPrivate: boolean, id?: string): void {
  const link = sshFormLink(id);
  if (!link) return void kb.text(`${label} (set MINIAPP_URL)`, "pp:noapp");
  if (isPrivate) kb.webApp(label, link);
  else kb.text(`${label} (DM me)`, "pp:sshdm");
}

function sshFormLink(id?: string): string | null {
  if (!botConfig.miniappUrl) return null;
  const base = `${botConfig.miniappUrl}/ssh.html`;
  return id ? `${base}?id=${encodeURIComponent(id)}` : base;
}

function sshName(p: PodView): string {
  return p.label || `${p.ssh_user}@${p.ssh_host}`;
}

function podLabel(p: PodView): string {
  if (p.kind === "ssh") return `🔌 ${sshName(p)} (${p.sessions.length})`;
  if (p.kind === "local") return `💻 ${p.label || p.id} (${p.sessions.length})`;
  return `🐳 ${p.label || p.id} (${p.sessions.length})`;
}

function sessName(s: { id: string; label: string | null }): string {
  return s.label || s.id;
}

function handleHint(chatId: number): string {
  const handles = listChatSessions(chatId).map((c) => `@${c.handle}`);
  return handles.length
    ? `Unknown handle. Address one of: ${handles.join(", ")}`
    : "No chat sessions yet. Open a pod in /pods and tap 💬 New (Telegram chat).";
}

type Routed =
  | { kind: "ok"; podId: string; sessionId: string; handle: string; body: string }
  | { kind: "hint"; message: string }
  | { kind: "none" };

// Resolve which chat session a message targets: a leading @handle (which also becomes the
// sticky focus), else the focused session. Shared by text and image handlers.
function resolveTarget(chatId: number, text: string, isGroup: boolean): Routed {
  const mention = text.match(/^@([a-z0-9][a-z0-9_-]{0,31})\s*([\s\S]*)$/i);
  if (mention) {
    const t = resolveHandle(mention[1]);
    if (!t) return { kind: "hint", message: handleHint(chatId) };
    setFocus(chatId, t.podId, t.sessionId);
    return { kind: "ok", podId: t.podId, sessionId: t.sessionId, handle: t.handle, body: mention[2].trim() };
  }
  // In a shared group, bare text is human chatter — never route it to a session on sticky focus,
  // or casual messages would land in a skip-permissions Claude. Require an explicit @handle.
  if (isGroup) return { kind: "none" };
  const focus = getFocus(chatId);
  if (focus) {
    const cs = getChatSession(focus.podId, focus.sessionId);
    return { kind: "ok", podId: focus.podId, sessionId: focus.sessionId, handle: cs?.handle ?? "", body: text };
  }
  return listChatSessions(chatId).length ? { kind: "hint", message: handleHint(chatId) } : { kind: "none" };
}

interface PendingGroup {
  podId: string;
  sessionId: string;
  handle: string;
  caption: string;
  paths: string[];
  timer: ReturnType<typeof setTimeout>;
}
// Telegram albums arrive as separate updates sharing a media_group_id; buffer briefly so all
// the images land in one PTY turn instead of one prompt per photo.
const mediaGroups = new Map<string, PendingGroup>();

function fileUrl(filePath: string): string {
  return `https://api.telegram.org/file/bot${botConfig.token}/${filePath}`;
}

function ingestReply(reason: "too_large" | "bad_type" | "fetch_failed"): string {
  if (reason === "too_large") return "That image is over 20MB (Telegram's cap) — send a smaller one.";
  if (reason === "bad_type") return "Only PNG / JPG / WebP / GIF images for now.";
  return "Couldn't fetch that image — try again.";
}

// [image: /path] refs that Claude reads as real bytes, with the caption (newlines flattened so
// the PTY line isn't split) trailing.
function imageRefs(podPaths: string[], caption: string): string {
  const refs = podPaths.map((p) => `[image: ${p}]`).join(" ");
  const cap = caption.replace(/\s*\n\s*/g, " ").trim();
  return cap ? `${refs} ${cap}` : refs;
}

async function flushGroup(key: string): Promise<void> {
  const g = mediaGroups.get(key);
  if (!g) return;
  mediaGroups.delete(key);
  if (!g.paths.length) return;
  try {
    await sendToSession(g.podId, g.sessionId, imageRefs(g.paths, g.caption));
  } catch (e) {
    console.error("media group flush failed", e);
  }
}

async function handleIncomingImage(
  ctx: Context,
  fileId: string,
  caption: string | undefined,
  mediaGroupId: string | undefined
): Promise<void> {
  const chatId = ctx.chat!.id;
  const key = mediaGroupId ? `${chatId}:${mediaGroupId}` : "";
  const existing = key ? mediaGroups.get(key) : undefined;

  let podId: string, sessionId: string, handle: string, body: string;
  if (existing) {
    ({ podId, sessionId, handle } = existing);
    body = "";
  } else {
    const r = resolveTarget(chatId, caption ?? "", ctx.chat!.type !== "private");
    if (r.kind === "hint") return void ctx.reply(r.message);
    if (r.kind === "none") return void ctx.reply("No session in focus — caption it with @handle to pick one.");
    ({ podId, sessionId, handle, body } = r);
  }

  if (!canWrite(effectiveRole(ctx.from?.id, ctx.from?.username, podId))) {
    return void ctx.reply("You have read-only access here — you can watch this session but not send to it.");
  }

  const pod = getPodRow(podId);
  if (!pod) return;

  let filePath: string | undefined;
  try {
    filePath = (await ctx.api.getFile(fileId)).file_path;
  } catch {}
  if (!filePath) return void ctx.reply(ingestReply("fetch_failed"));

  const result = await ingestImage(fileUrl(filePath));
  if (!result.ok) return void ctx.reply(ingestReply(result.reason));

  let podPath: string;
  try {
    podPath = await writeToPod(pod, sessionId, result.name, result.data);
  } catch (e) {
    return void ctx.reply(`Couldn't place the image on the pod: ${(e as Error).message}`);
  }

  if (key) {
    let g = mediaGroups.get(key);
    if (!g) {
      g = { podId, sessionId, handle, caption: body, paths: [], timer: setTimeout(() => flushGroup(key), 1200) };
      mediaGroups.set(key, g);
    } else if (body && !g.caption) {
      g.caption = body;
    }
    g.paths.push(podPath);
    return;
  }

  try {
    await sendToSession(podId, sessionId, imageRefs([podPath], body));
  } catch (e) {
    await ctx.reply(`Couldn't reach @${handle}: ${(e as Error).message}`);
  }
}

function podsView(uid?: number, uname?: string): { text: string; keyboard: InlineKeyboard } {
  const owner = isOwner(uid, uname);
  const pods = listPods().filter((p) => p.status === "running" && effectiveRole(uid, uname, p.id) !== null);
  const kb = new InlineKeyboard();
  if (pods.length === 0) {
    if (owner) kb.text("+ New Pod", "pp:newpod");
    return { text: owner ? "No pods yet." : "No pods you can access yet.", keyboard: kb };
  }
  for (const p of pods) {
    kb.text(podLabel(p), `pp:pod:${p.id}`);
    if (owner) kb.text("× delete", `pp:delpod:${p.id}`);
    kb.row();
  }
  if (owner) kb.text("+ New Pod", "pp:newpod");
  return { text: "Pods — tap one to manage its sessions.", keyboard: kb };
}

function sshView(isPrivate: boolean): { text: string; keyboard: InlineKeyboard } {
  const pods = listPods().filter((p) => p.kind === "ssh" && p.status === "running");
  const kb = new InlineKeyboard();
  for (const p of pods) {
    kb.text(`🔌 ${sshName(p)}`, `pp:pod:${p.id}`).row();
    addSshFormButton(kb, "✏️ edit", isPrivate, p.id);
    kb.text("test", `pp:sshtest:${p.id}`).text("× delete", `pp:delpod:${p.id}`).row();
  }
  addSshFormButton(kb, "➕ Add SSH endpoint", isPrivate);
  return {
    text: pods.length === 0 ? "No SSH endpoints yet." : "SSH endpoints:",
    keyboard: kb,
  };
}

function podView(podId: string, uid?: number, uname?: string): { text: string; keyboard: InlineKeyboard } {
  const pod = getPod(podId);
  const kb = new InlineKeyboard();
  if (!pod) {
    kb.text("‹ Pods", "pp:pods");
    return { text: `Pod ${podId} no longer exists.`, keyboard: kb };
  }

  const owner = isOwner(uid, uname);
  const writable = canWrite(effectiveRole(uid, uname, podId));
  const hostDisabled = pod.kind === "local" && !botConfig.hostMode;

  for (const s of pod.sessions) {
    const cs = getChatSession(podId, s.id);
    const name = cs ? `💬 @${cs.handle}` : sessName(s);
    if (hostDisabled) {
      kb.text(`▶ ${name} (host mode off)`, "pp:hostoff");
    } else if (!addOpenButton(kb, `${writable ? "▶" : "👁"} ${name}`, podId, s.id)) {
      kb.text(`▶ ${name} (set MINIAPP_URL)`, "pp:noapp");
    }
    if (writable) {
      kb.text("✏️", `pp:renamesess:${podId}:${s.id}`).text("× kill", `pp:delsess:${podId}:${s.id}`);
    }
    kb.row();
  }

  if (writable && pod.kind !== "local") {
    kb.text("⚡ New (skip-perms)", `pp:newsess:${podId}:danger`)
      .text("🔒 New (regular)", `pp:newsess:${podId}:regular`)
      .row();
    kb.text("💬 New (Telegram chat)", `pp:newchat:${podId}`).row();
  }
  if (writable && !hostDisabled) kb.text("🖥 New Terminal (shell)", `pp:newsess:${podId}:terminal`).row();
  kb.text("‹ Pods", "pp:pods");
  if (owner) {
    kb.text("✏️ rename", `pp:renamepod:${podId}`).text("× delete", `pp:delpod:${podId}`);
    if (isGrantablePod(pod.kind)) kb.row().text("👥 Access", `pp:access:${podId}`);
  }

  const kindTag = pod.kind === "ssh" ? `🔌 ${sshName(pod)}` : pod.kind === "local" ? "💻 host" : "🐳 docker";
  const header = pod.label ? `Pod "${pod.label}" (${podId}) · ${kindTag}` : `Pod ${podId} · ${kindTag}`;
  const lines = [
    header,
    "",
    hostDisabled
      ? "Host mode is off. Re-enable it (onboard, or start --host-mode true) to open sessions, or delete this pod."
      : pod.sessions.length === 0
        ? "No sessions yet. Start one below."
        : "Tap ▶ to open a session terminal.",
  ];
  return { text: lines.join("\n"), keyboard: kb };
}

function sessionsView(uid?: number, uname?: string): { text: string; keyboard: InlineKeyboard } {
  const pods = listPods().filter((p) => effectiveRole(uid, uname, p.id) !== null);
  const kb = new InlineKeyboard();
  let count = 0;
  for (const p of pods) {
    const writable = canWrite(effectiveRole(uid, uname, p.id));
    for (const s of p.sessions) {
      const name = `${p.label || p.id} · ${sessName(s)}`;
      if (!addOpenButton(kb, `${writable ? "▶" : "👁"} ${name}`, p.id, s.id)) {
        kb.text(`▶ ${name} (set MINIAPP_URL)`, "pp:noapp");
      }
      if (writable) kb.text("× kill", `pp:delsess:${p.id}:${s.id}`);
      kb.row();
      count++;
    }
  }
  kb.text("‹ Pods", "pp:pods");
  return {
    text: count === 0 ? "No sessions you can access. Use /pods." : "All sessions:",
    keyboard: kb,
  };
}

function accessView(podId: string): { text: string; keyboard: InlineKeyboard } {
  const pod = getPod(podId);
  const kb = new InlineKeyboard();
  if (!pod) {
    kb.text("‹ Pods", "pp:pods");
    return { text: `Pod ${podId} no longer exists.`, keyboard: kb };
  }
  for (const e of listAccess(podId)) {
    const who = e.username ? `@${e.username}` : `id ${e.userId}`;
    kb.text(`${who} — ${e.role}${e.pending ? " (pending)" : ""}`, "pp:noop");
    if (e.pending) kb.text("× remove", `pp:revpend:${podId}:${e.username}`);
    else kb.text("× remove", `pp:revuser:${podId}:${e.userId}`);
    kb.row();
  }
  kb.text("➕ Add", `pp:grantadd:${podId}`).row();
  kb.text("‹ Back", `pp:pod:${podId}`);
  const label = pod.label || podId;
  return {
    text: `Access for "${label}" — you (owner) always have full access.\nAdd writers (can drive sessions) or readers (read-only terminal).`,
    keyboard: kb,
  };
}

export function startBot(): void {
  if (!botConfig.token) {
    console.info("bot disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }
  if (openMode()) {
    console.warn(
      "No owners configured (TELEGRAM_ALLOWED_USER_IDS / TELEGRAM_ALLOWED_USERNAMES) — bot allows any user"
    );
  }
  if (!botConfig.miniappUrl) {
    console.warn("MINIAPP_URL not set — terminal mini app buttons disabled");
  }

  const bot = new Bot(botConfig.token);
  setNotifierBot(bot);
  // Needed to build direct-link mini app deep links (t.me/<bot>/<app>?startapp=…).
  bot.api.getMe().then((me) => setBotUsername(me.username)).catch((e) => console.error("getMe failed", e));

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) {
      // In groups (privacy off) the bot sees every member's messages; don't log-spam non-members.
      if (ctx.chat?.type === "private") {
        console.warn(`bot rejected user id=${ctx.from?.id} username=@${ctx.from?.username ?? "?"}`);
      }
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) recordChat(chatId);
    await maybePromoteInvitee(ctx);
    await next();
  });

  // Any unrelated button press abandons a half-started rename / new-chat / grant prompt.
  bot.on("callback_query:data", async (ctx, next) => {
    const d = ctx.callbackQuery.data;
    if (ctx.chat) {
      if (!d.startsWith("pp:rename")) pendingRename.delete(ctx.chat.id);
      if (!d.startsWith("pp:newchat")) pendingNewChat.delete(ctx.chat.id);
      if (!d.startsWith("pp:grantadd")) pendingGrant.delete(ctx.chat.id);
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "pairpod terminal bot.\n\n/pods — manage pods & sessions\n/sessions — list all sessions\n/help — reference\n\nTap a session's ▶ button to open a live terminal inside Telegram."
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "pairpod terminal bot",
        "",
        "/pods — list pods; create/delete; open a pod to manage its sessions",
        "/sessions — list every session with an Open button",
        "/ssh — register/test/delete SSH endpoints (remote hosts as pods)",
        "",
        botConfig.hostMode
          ? "New pod backends: 🐳 Docker (a fresh container), 🔌 SSH (a remote host), or 💻 Host (a shell on the bot machine)."
          : "New pod backends: 🐳 Docker (a fresh container) or 🔌 SSH (a remote host).",
        "",
        "Sessions come in four modes (Docker and SSH):",
        "⚡ skip-perms — claude --dangerously-skip-permissions",
        "🔒 regular — claude (answer permission prompts in the terminal)",
        "🖥 terminal — a plain shell",
        "💬 chat — talk to claude right here in Telegram; you name it and address it as @handle",
        "SSH Claude sessions need claude installed + logged in on the remote, and MINIAPP_URL set.",
        "",
        "▶ opens a byte-identical terminal (xterm) as a Telegram mini app.",
        "For a 💬 chat session, just message @handle (e.g. \"@sess1 how are things?\") — replies come back here.",
      ].join("\n")
    );
  });

  bot.command("whoami", async (ctx) => {
    const uid = ctx.from?.id;
    const uname = ctx.from?.username;
    const owner = isOwner(uid, uname);
    const lines = [
      `id: ${uid}`,
      `username: @${uname ?? "(none)"}`,
      `role: ${owner ? "owner (full access)" : "guest"}`,
    ];
    if (!owner) {
      const pods = listPods().filter((p) => effectiveRole(uid, uname, p.id) !== null);
      lines.push("", pods.length ? "Pods you can access:" : "No pod access yet.");
      for (const p of pods) lines.push(`• ${p.label || p.id} — ${effectiveRole(uid, uname, p.id)}`);
    }
    await ctx.reply(lines.join("\n"));
  });

  bot.command("pods", async (ctx) => {
    const v = podsView(ctx.from?.id, ctx.from?.username);
    await ctx.reply(v.text, { reply_markup: v.keyboard });
  });

  bot.command("sessions", async (ctx) => {
    const v = sessionsView(ctx.from?.id, ctx.from?.username);
    await ctx.reply(v.text, { reply_markup: v.keyboard });
  });

  bot.command("ssh", async (ctx) => {
    const v = sshView(ctx.chat?.type === "private");
    await ctx.reply(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery("pp:sshdm", async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "SSH endpoint forms only open in a private chat with me — message me directly to add or edit one.",
      show_alert: true,
    });
  });

  bot.callbackQuery("pp:noapp", async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Set MINIAPP_URL (https tunnel) to enable the terminal mini app.",
      show_alert: true,
    });
  });

  bot.callbackQuery("pp:hostoff", async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Host mode is off. Enable it (onboard, or start --host-mode true) to open host sessions.",
      show_alert: true,
    });
  });

  bot.callbackQuery("pp:noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("pp:pods", async (ctx) => {
    const v = podsView(ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("pp:sessions", async (ctx) => {
    const v = sessionsView(ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("pp:newpod", async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const kb = new InlineKeyboard().text("🐳 Docker", "pp:newdocker");
    if (botConfig.hostMode) kb.text("💻 Host", "pp:newhost");
    addSshFormButton(kb, "🔌 SSH", ctx.chat?.type === "private");
    kb.row().text("‹ Pods", "pp:pods");
    await ctx.editMessageText("New pod — choose a backend:", { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("pp:newdocker", async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    await ctx.answerCallbackQuery({ text: "Creating pod…" });
    try {
      await createPod();
    } catch (e) {
      await ctx.reply(`Failed to create pod: ${(e as Error).message}`);
      return;
    }
    const v = podsView(ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery("pp:newhost", async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    if (!botConfig.hostMode) {
      await ctx.answerCallbackQuery({ text: "Host mode is disabled.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Creating host pod…" });
    try {
      createLocalPod();
    } catch (e) {
      await ctx.reply(`Failed to create host pod: ${(e as Error).message}`);
      return;
    }
    const v = podsView(ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery(/^pp:sshtest:(.+)$/, async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const podId = ctx.match[1];
    try {
      const out = await testPod(podId);
      await ctx.answerCallbackQuery({ text: `OK — ${out}`, show_alert: true });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: `Failed: ${(e as Error).message}`, show_alert: true });
    }
  });

  bot.callbackQuery(/^pp:pod:(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
    if (effectiveRole(ctx.from?.id, ctx.from?.username, podId) === null) {
      await ctx.answerCallbackQuery({ text: "You don't have access to this pod.", show_alert: true });
      return;
    }
    const v = podView(podId, ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^pp:delpod:(.+)$/, async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const podId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: "Deleting pod…" });
    try {
      await deletePod(podId);
    } catch (e) {
      await ctx.reply(`Failed to delete pod: ${(e as Error).message}`);
      return;
    }
    const v = podsView(ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery(/^pp:access:(.+)$/, async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const podId = ctx.match[1];
    const pod = getPodRow(podId);
    if (!pod || !isGrantablePod(pod.kind)) {
      await ctx.answerCallbackQuery({ text: "Host pods are owner-only and can't be shared.", show_alert: true });
      return;
    }
    const v = accessView(podId);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^pp:grantadd:(.+)$/, async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const podId = ctx.match[1];
    if (ctx.chat) pendingGrant.set(ctx.chat.id, { podId });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send "@username writer" or "@username reader" (or a numeric id) to grant access to ${podId}.`, {
      reply_markup: { force_reply: true, input_field_placeholder: "@user writer" },
    });
  });

  bot.callbackQuery(/^pp:revuser:([^:]+):(\d+)$/, async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    revokeAccess(parseInt(ctx.match[2], 10), ctx.match[1]);
    const v = accessView(ctx.match[1]);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery({ text: "Removed." });
  });

  bot.callbackQuery(/^pp:revpend:([^:]+):(.+)$/, async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    revokePending(ctx.match[2], ctx.match[1]);
    const v = accessView(ctx.match[1]);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery({ text: "Removed." });
  });

  bot.callbackQuery(/^pp:renamepod:(.+)$/, async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const podId = ctx.match[1];
    if (ctx.chat) pendingRename.set(ctx.chat.id, { podId });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send a name for ${podId} (your next message). Send "-" to clear it.`, {
      reply_markup: { force_reply: true, input_field_placeholder: "pod name" },
    });
  });

  bot.callbackQuery(/^pp:renamesess:(.+):(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
    if (!(await requireWrite(ctx, podId))) return;
    const sessionId = ctx.match[2];
    if (ctx.chat) pendingRename.set(ctx.chat.id, { podId, sessionId });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send a name for session ${sessionId} (your next message). Send "-" to clear it.`, {
      reply_markup: { force_reply: true, input_field_placeholder: "session name" },
    });
  });

  bot.callbackQuery(/^pp:newsess:(.+):(danger|regular|terminal)$/, async (ctx) => {
    const podId = ctx.match[1];
    if (!(await requireWrite(ctx, podId))) return;
    const mode = ctx.match[2] as SessionMode;
    const pod = getPod(podId);
    if (pod?.kind === "local" && !botConfig.hostMode) {
      await ctx.answerCallbackQuery({ text: "Host mode is disabled.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Starting session…" });
    try {
      await createSession(podId, mode);
    } catch (e) {
      await ctx.reply(`Failed to start session: ${(e as Error).message}`);
      return;
    }
    const v = podView(podId, ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery(/^pp:newchat:(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
    if (!(await requireWrite(ctx, podId))) return;
    const pod = getPod(podId);
    if (!pod || pod.kind === "local") {
      await ctx.answerCallbackQuery({ text: "Chat sessions need a Docker or SSH pod.", show_alert: true });
      return;
    }
    if (ctx.chat) pendingNewChat.set(ctx.chat.id, { podId });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Send a handle for the new chat session on ${pod.label || podId} — you'll address it as @handle from this chat. Letters, digits, dash or underscore.`,
      { reply_markup: { force_reply: true, input_field_placeholder: "e.g. sess1" } }
    );
  });

  bot.callbackQuery(/^pp:delsess:(.+):(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
    if (!(await requireWrite(ctx, podId))) return;
    const sessionId = ctx.match[2];
    await ctx.answerCallbackQuery({ text: "Killing session…" });
    try {
      await deleteSession(podId, sessionId);
    } catch (e) {
      await ctx.reply(`Failed to kill session: ${(e as Error).message}`);
      return;
    }
    const v = podView(podId, ctx.from?.id, ctx.from?.username);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;

    // 1. Capturing a name for a pending rename.
    const pending = pendingRename.get(chatId);
    if (pending) {
      pendingRename.delete(chatId);
      const text = ctx.message.text.trim();
      const label = text === "-" ? null : text;
      try {
        if (pending.sessionId) setSessionLabel(pending.podId, pending.sessionId, label);
        else setPodLabel(pending.podId, label);
      } catch (e) {
        await ctx.reply(`Rename failed: ${(e as Error).message}`);
        return;
      }
      const v = podView(pending.podId, ctx.from?.id, ctx.from?.username);
      await ctx.reply(v.text, { reply_markup: v.keyboard });
      return;
    }

    // 2. Capturing a handle for a new chat session.
    const newChat = pendingNewChat.get(chatId);
    if (newChat) {
      pendingNewChat.delete(chatId);
      const handle = ctx.message.text.trim();
      try {
        await createSession(newChat.podId, "chat", { handle, chatId });
      } catch (e) {
        await ctx.reply(`Couldn't create chat session: ${(e as Error).message}`);
        return;
      }
      const h = normalizeHandle(handle);
      await ctx.reply(`💬 chat session @${h} is up and in focus. Just type to talk to it, or address another with @handle.`);
      return;
    }

    // 3. Capturing an access grant ("@user writer" / numeric id).
    const grantReq = pendingGrant.get(chatId);
    if (grantReq) {
      pendingGrant.delete(chatId);
      if (!isOwner(ctx.from?.id, ctx.from?.username)) return void ctx.reply("Owner only.");
      const [target, roleArg = "reader"] = ctx.message.text.trim().split(/\s+/);
      const role = roleArg.toLowerCase();
      if (!target || !isGrantRole(role)) {
        return void ctx.reply('Format: "@username writer" or "@username reader" (or a numeric id).');
      }
      const pod = getPodRow(grantReq.podId);
      if (!pod) return void ctx.reply("Pod no longer exists.");
      if (!isGrantablePod(pod.kind)) return void ctx.reply("Host pods are owner-only and can't be shared.");
      const res = grant(target, grantReq.podId, role, ctx.from!.id);
      await ctx.reply(
        res.pending
          ? `Invited ${target} as ${role} — applies when they next message the bot.`
          : `Granted ${target} ${role} on ${grantReq.podId}.`
      );
      const v = accessView(grantReq.podId);
      await ctx.reply(v.text, { reply_markup: v.keyboard });
      return;
    }

    // 4. Routing a message to a chat-bridged session.
    const r = resolveTarget(chatId, ctx.message.text, ctx.chat.type !== "private");
    if (r.kind === "hint") {
      await ctx.reply(r.message);
      return;
    }
    if (r.kind === "none") return;
    if (!canWrite(effectiveRole(ctx.from?.id, ctx.from?.username, r.podId))) {
      await ctx.reply("You have read-only access here — you can watch this session but not send to it.");
      return;
    }
    if (!r.body) {
      await ctx.reply(`▶ now talking to @${r.handle}`);
      return;
    }
    try {
      await sendToSession(r.podId, r.sessionId, r.body);
    } catch (e) {
      await ctx.reply(`Couldn't reach @${r.handle}: ${(e as Error).message}`);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // largest size
    await handleIncomingImage(ctx, photo.file_id, ctx.message.caption, ctx.message.media_group_id);
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) {
      await ctx.reply("Only PNG / JPG / WebP / GIF images for now.");
      return;
    }
    await handleIncomingImage(ctx, doc.file_id, ctx.message.caption, ctx.message.media_group_id);
  });

  for (const kind of ["video", "audio", "voice", "sticker", "video_note", "animation"] as const) {
    bot.on(`message:${kind}`, async (ctx) => {
      await ctx.reply("Only images are supported for now (PNG / JPG / WebP / GIF).");
    });
  }

  bot.catch((err) => console.error("bot error", err));

  bot.api
    .setMyCommands([
      { command: "pods", description: "List pods; create, delete, manage sessions" },
      { command: "sessions", description: "List all sessions with an open button" },
      { command: "ssh", description: "List SSH endpoints; add, test, delete" },
      { command: "whoami", description: "Show your Telegram id and username" },
      { command: "help", description: "How the terminal bot works" },
    ])
    .catch((e) => console.error("setMyCommands failed", e));

  run(bot);
  console.info("bot started");
}
