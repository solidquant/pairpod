import { Bot, InlineKeyboard, type Context } from "grammy";
import { run } from "@grammyjs/runner";
import { botConfig } from "./config.js";
import { updateEnv } from "./env.js";
import { isAllowed, hasAllowlist } from "./access.js";
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

// chat id -> a pending rename target; the user's next text message becomes the name.
const pendingRename = new Map<number, { podId: string; sessionId?: string }>();
// chat id -> a pod awaiting a handle; the user's next text message names a new chat session.
const pendingNewChat = new Map<number, { podId: string }>();

// When the allowlist holds a username but not yet a numeric id, the first private
// message from that handle pins its id into the allowlist (ids can't be reassigned).
async function maybePinUserId(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (ctx.chat?.type !== "private" || !from?.id || !from.username) return;
  if (!botConfig.allowedUsernames.includes(from.username.toLowerCase())) return;
  if (botConfig.allowedUserIds.includes(from.id)) return;
  botConfig.allowedUserIds.push(from.id);
  try {
    updateEnv({ TELEGRAM_ALLOWED_USER_IDS: botConfig.allowedUserIds.join(",") });
  } catch (e) {
    console.error("failed to persist pinned user id", e);
  }
  await ctx.reply(
    `🔒 Pinned your numeric id ${from.id} to the allowlist — sturdier than @${from.username}, which Telegram lets people reassign.`
  );
}

function miniappLink(podId: string, sessionId: string): string | null {
  if (!botConfig.miniappUrl) return null;
  return `${botConfig.miniappUrl}/?pod=${encodeURIComponent(podId)}&session=${encodeURIComponent(sessionId)}`;
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

function podsView(): { text: string; keyboard: InlineKeyboard } {
  const pods = listPods().filter((p) => p.status === "running");
  const kb = new InlineKeyboard();
  if (pods.length === 0) {
    kb.text("+ New Pod", "pp:newpod");
    return { text: "No pods yet.", keyboard: kb };
  }
  for (const p of pods) {
    kb.text(podLabel(p), `pp:pod:${p.id}`)
      .text("× delete", `pp:delpod:${p.id}`)
      .row();
  }
  kb.text("+ New Pod", "pp:newpod");
  return { text: "Pods — tap one to manage its sessions.", keyboard: kb };
}

function sshView(): { text: string; keyboard: InlineKeyboard } {
  const pods = listPods().filter((p) => p.kind === "ssh" && p.status === "running");
  const kb = new InlineKeyboard();
  for (const p of pods) {
    kb.text(`🔌 ${sshName(p)}`, `pp:pod:${p.id}`).row();
    const editLink = sshFormLink(p.id);
    if (editLink) kb.webApp("✏️ edit", editLink);
    else kb.text("✏️ edit (set MINIAPP_URL)", "pp:noapp");
    kb.text("test", `pp:sshtest:${p.id}`).text("× delete", `pp:delpod:${p.id}`).row();
  }
  const link = sshFormLink();
  if (link) kb.webApp("➕ Add SSH endpoint", link);
  else kb.text("➕ Add SSH (set MINIAPP_URL)", "pp:noapp");
  return {
    text: pods.length === 0 ? "No SSH endpoints yet." : "SSH endpoints:",
    keyboard: kb,
  };
}

function podView(podId: string): { text: string; keyboard: InlineKeyboard } {
  const pod = getPod(podId);
  const kb = new InlineKeyboard();
  if (!pod) {
    kb.text("‹ Pods", "pp:pods");
    return { text: `Pod ${podId} no longer exists.`, keyboard: kb };
  }

  const hostDisabled = pod.kind === "local" && !botConfig.hostMode;

  for (const s of pod.sessions) {
    const cs = getChatSession(podId, s.id);
    const name = cs ? `💬 @${cs.handle}` : sessName(s);
    if (hostDisabled) {
      kb.text(`▶ ${name} (host mode off)`, "pp:hostoff");
    } else {
      const link = miniappLink(podId, s.id);
      if (link) kb.webApp(`▶ ${name}`, link);
      else kb.text(`▶ ${name} (set MINIAPP_URL)`, "pp:noapp");
    }
    kb.text("✏️", `pp:renamesess:${podId}:${s.id}`)
      .text("× kill", `pp:delsess:${podId}:${s.id}`)
      .row();
  }

  if (pod.kind !== "local") {
    kb.text("⚡ New (skip-perms)", `pp:newsess:${podId}:danger`)
      .text("🔒 New (regular)", `pp:newsess:${podId}:regular`)
      .row();
    kb.text("💬 New (Telegram chat)", `pp:newchat:${podId}`).row();
  }
  if (!hostDisabled) kb.text("🖥 New Terminal (shell)", `pp:newsess:${podId}:terminal`).row();
  kb.text("‹ Pods", "pp:pods")
    .text("✏️ rename", `pp:renamepod:${podId}`)
    .text("× delete", `pp:delpod:${podId}`);

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

function sessionsView(): { text: string; keyboard: InlineKeyboard } {
  const pods = listPods();
  const kb = new InlineKeyboard();
  let count = 0;
  for (const p of pods) {
    for (const s of p.sessions) {
      const name = `${p.label || p.id} · ${sessName(s)}`;
      const link = miniappLink(p.id, s.id);
      if (link) kb.webApp(`▶ ${name}`, link);
      else kb.text(`▶ ${name} (set MINIAPP_URL)`, "pp:noapp");
      kb.text("× kill", `pp:delsess:${p.id}:${s.id}`).row();
      count++;
    }
  }
  kb.text("‹ Pods", "pp:pods");
  return {
    text: count === 0 ? "No sessions. Use /pods to create one." : "All sessions:",
    keyboard: kb,
  };
}

export function startBot(): void {
  if (!botConfig.token) {
    console.info("bot disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }
  if (!hasAllowlist()) {
    console.warn(
      "No allowlist set (TELEGRAM_ALLOWED_USERNAMES / TELEGRAM_ALLOWED_USER_IDS) — bot allows any user"
    );
  }
  if (!botConfig.miniappUrl) {
    console.warn("MINIAPP_URL not set — terminal mini app buttons disabled");
  }

  const bot = new Bot(botConfig.token);
  setNotifierBot(bot);

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, ctx.from?.username)) {
      console.warn(
        `bot rejected user id=${ctx.from?.id} username=@${ctx.from?.username ?? "?"}`
      );
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) recordChat(chatId);
    await maybePinUserId(ctx);
    await next();
  });

  // Any unrelated button press abandons a half-started rename or new-chat prompt.
  bot.on("callback_query:data", async (ctx, next) => {
    const d = ctx.callbackQuery.data;
    if (ctx.chat) {
      if (!d.startsWith("pp:rename")) pendingRename.delete(ctx.chat.id);
      if (!d.startsWith("pp:newchat")) pendingNewChat.delete(ctx.chat.id);
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
    await ctx.reply(
      `id: ${ctx.from?.id}\nusername: @${ctx.from?.username ?? "(none)"}\n\nPin the numeric id via TELEGRAM_ALLOWED_USER_IDS for a stable lock.`
    );
  });

  bot.command("pods", async (ctx) => {
    const v = podsView();
    await ctx.reply(v.text, { reply_markup: v.keyboard });
  });

  bot.command("sessions", async (ctx) => {
    const v = sessionsView();
    await ctx.reply(v.text, { reply_markup: v.keyboard });
  });

  bot.command("ssh", async (ctx) => {
    const v = sshView();
    await ctx.reply(v.text, { reply_markup: v.keyboard });
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

  bot.callbackQuery("pp:pods", async (ctx) => {
    const v = podsView();
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("pp:sessions", async (ctx) => {
    const v = sessionsView();
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("pp:newpod", async (ctx) => {
    const kb = new InlineKeyboard().text("🐳 Docker", "pp:newdocker");
    if (botConfig.hostMode) kb.text("💻 Host", "pp:newhost");
    const link = sshFormLink();
    if (link) kb.webApp("🔌 SSH", link);
    else kb.text("🔌 SSH (set MINIAPP_URL)", "pp:noapp");
    kb.row().text("‹ Pods", "pp:pods");
    await ctx.editMessageText("New pod — choose a backend:", { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("pp:newdocker", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Creating pod…" });
    try {
      await createPod();
    } catch (e) {
      await ctx.reply(`Failed to create pod: ${(e as Error).message}`);
      return;
    }
    const v = podsView();
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery("pp:newhost", async (ctx) => {
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
    const v = podsView();
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery(/^pp:sshtest:(.+)$/, async (ctx) => {
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
    const v = podView(podId);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^pp:delpod:(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: "Deleting pod…" });
    try {
      await deletePod(podId);
    } catch (e) {
      await ctx.reply(`Failed to delete pod: ${(e as Error).message}`);
      return;
    }
    const v = podsView();
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery(/^pp:renamepod:(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
    if (ctx.chat) pendingRename.set(ctx.chat.id, { podId });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send a name for ${podId} (your next message). Send "-" to clear it.`, {
      reply_markup: { force_reply: true, input_field_placeholder: "pod name" },
    });
  });

  bot.callbackQuery(/^pp:renamesess:(.+):(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
    const sessionId = ctx.match[2];
    if (ctx.chat) pendingRename.set(ctx.chat.id, { podId, sessionId });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send a name for session ${sessionId} (your next message). Send "-" to clear it.`, {
      reply_markup: { force_reply: true, input_field_placeholder: "session name" },
    });
  });

  bot.callbackQuery(/^pp:newsess:(.+):(danger|regular|terminal)$/, async (ctx) => {
    const podId = ctx.match[1];
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
    const v = podView(podId);
    await ctx.editMessageText(v.text, { reply_markup: v.keyboard });
  });

  bot.callbackQuery(/^pp:newchat:(.+)$/, async (ctx) => {
    const podId = ctx.match[1];
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
    const sessionId = ctx.match[2];
    await ctx.answerCallbackQuery({ text: "Killing session…" });
    try {
      await deleteSession(podId, sessionId);
    } catch (e) {
      await ctx.reply(`Failed to kill session: ${(e as Error).message}`);
      return;
    }
    const v = podView(podId);
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
      const v = podView(pending.podId);
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

    // 3. Routing a message to a chat-bridged session.
    const raw = ctx.message.text;
    const mention = raw.match(/^@([a-z0-9][a-z0-9_-]{0,31})\s*([\s\S]*)$/i);
    if (mention) {
      const target = resolveHandle(mention[1]);
      if (!target) {
        await ctx.reply(handleHint(chatId));
        return;
      }
      setFocus(chatId, target.podId, target.sessionId);
      const body = mention[2].trim();
      if (!body) {
        await ctx.reply(`▶ now talking to @${target.handle}`);
        return;
      }
      try {
        await sendToSession(target.podId, target.sessionId, body);
      } catch (e) {
        await ctx.reply(`Couldn't reach @${target.handle}: ${(e as Error).message}`);
      }
      return;
    }

    const focus = getFocus(chatId);
    if (!focus) {
      if (listChatSessions(chatId).length) await ctx.reply(handleHint(chatId));
      return;
    }
    try {
      await sendToSession(focus.podId, focus.sessionId, raw);
    } catch (e) {
      await ctx.reply(`Couldn't reach the session: ${(e as Error).message}`);
    }
  });

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
