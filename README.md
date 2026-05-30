# pairpod

Run terminals and Claude Code sessions from your phone, through a Telegram bot.

Point pairpod at a backend (a Docker container, an SSH host, or the machine the bot runs on) and it gives you a real terminal inside a Telegram mini app. Start a plain shell or a Claude Code session, attach from anywhere, scroll, copy, pinch to zoom. It's xterm over a WebSocket, so it behaves the way you'd expect.

## Concepts

A **pod** is a backend. A **session** is a terminal running on it.

Pods come in three kinds:

| Kind | What it is |
|---|---|
| 🐳 Docker | a throwaway, isolated container on the bot host |
| 🔌 SSH | a remote machine reached over SSH |
| 💻 Host | a shell on the bot machine itself — **off by default** (see [Host mode](#host-mode)) |

Sessions come in three modes:

| Mode | Runs |
|---|---|
| terminal | a plain shell |
| regular | `claude` — you answer the permission prompts |
| skip-perms | `claude --dangerously-skip-permissions` |

Docker and SSH pods run all three modes; Host pods are terminal-only. You can name pods and sessions, which keeps a list of `pod-7` / `claude-3` readable once you have a few.

## Quick start

You'll need Node 22 and [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`). Docker is optional; only Docker pods touch it.

Install from npm:

```bash
npm install -g pairpod
pairpod onboard     # asks for a bot token, allowed users, and a port
pairpod start       # opens the tunnel and starts the bot together
```

`onboard` points you at [@BotFather](https://t.me/BotFather) to create a bot, then writes everything to `~/.pairpod/.env` and generates a vault key for you. `start` brings up a cloudflared tunnel, points the bot at its URL, and runs both. One command, and Ctrl-C stops everything.

Then message your bot `/pods`, create one, and tap ▶ to open a terminal.

> pairpod needs Node 22 — its native deps (`better-sqlite3`, `node-pty`) won't load on Node 20. Check with `node -v`; `nvm install 22 && nvm use 22` if you're behind.

### From source

Working on pairpod itself? Clone the repo and use the workspace instead of the published package. You'll also need pnpm.

```bash
nvm use
pnpm install
pnpm onboard
pnpm start
```

## Where state lives

Everything host-specific sits under `~/.pairpod/` (set `PAIRPOD_HOME` to move it):

```
~/.pairpod/
  .env                config
  pairpod.db          pods and sessions
  vault/              encrypted SSH credentials
  workspaces/         Docker pod working dirs
  notify-chats.json   who gets permission pings
```

Nothing gets written into the repo.

## Layout

```
packages/
  bot/    the Fastify server, grammy bot, and the mini app
  cli/    the `pairpod` command
docker/   the image Docker pods run
```

It's a pnpm workspace. `packages/bot` is the whole app: the server, the bot, the pod/session store, the Docker/SSH/PTY backends, and the vault. `packages/cli` is the small `pairpod` command that onboards and launches it.

## Commands

In Telegram:

- `/pods` — your pods; create, rename, delete, open sessions
- `/sessions` — every session with an open button
- `/ssh` — add, test, edit, or remove SSH hosts
- `/whoami` — your id and username, for locking down the allowlist

On the command line, with the `pairpod` CLI:

- `pairpod onboard` — write `~/.pairpod/.env`
- `pairpod start` — tunnel plus bot
- `pairpod start --no-tunnel` — bot only, using a `MINIAPP_URL` you set yourself
- `pairpod start --host-mode true|false` — allow/forbid Host pods for this run (overrides `HOST_MODE`)

From a clone of the repo, run these through pnpm (`pnpm onboard`, `pnpm start`), plus two dev-only scripts:

- `pnpm dev` — hot-reload the bot, no tunnel (for development)
- `pnpm build` — compile both packages to `dist/`

## SSH hosts

Add one from `/ssh` → Add SSH endpoint, or while creating a pod. The form opens in the mini app, so the secret travels over HTTPS rather than through a chat message. Three ways to authenticate:

| Method | What's stored | Use it when |
|---|---|---|
| ssh-agent | nothing | the key's already loaded in your agent on the bot host; best for passphrase-protected keys |
| key file | just the path | the key file lives on the bot host and never leaves it |
| paste key | the key, encrypted | there's no file on the host; needs the vault |

Anything you paste (a key, a passphrase) is encrypted with AES-256-GCM. The master key comes from `PAIRPOD_VAULT_KEY` and only lives in memory, never on disk beside the ciphertext and never in the database. `onboard` generates it.

Running Claude on an SSH host needs `claude` installed and logged in over there (open a terminal session and run it once), plus a reachable `MINIAPP_URL`/`PAIRPOD_PUBLIC_URL` so permission prompts can notify you. The first connection to a host pins its key fingerprint and verifies it every time after.

## Worth knowing

A cloudflared quick tunnel terminates TLS at Cloudflare's edge, so a pasted key or passphrase is briefly in the clear there. If that bothers you, use ssh-agent (nothing leaves the host) or a fixed named tunnel.

The bot only answers people on your allowlist, and the mini app checks Telegram's signed `initData` on every connection — knowing the tunnel URL isn't enough to get in. Set the allowlist: the first private message from an allowed `@handle` pins its numeric id into `~/.pairpod/.env` automatically, so you end up locked to a stable id (handles can be reassigned) without looking it up.

### Host mode

Docker pods are isolated and SSH pods are a separate machine, but a **Host pod is an un-sandboxed shell on the bot machine itself**. So Host mode is **off by default** and gated behind a server-side flag — flipping it needs filesystem access to the bot host, which a remote Telegram user (even one who got past the allowlist) doesn't have:

- `onboard` asks whether to enable it, with a warning.
- `HOST_MODE=true` in `~/.pairpod/.env` turns it on persistently.
- `pairpod start --host-mode true|false` overrides that for one run.

When it's off the 💻 Host button is hidden and the server refuses to create or attach host sessions, even if a request is crafted by hand. When a host session does run, `PAIRPOD_VAULT_KEY` and the bot token are scrubbed from its environment, so a host shell can't read the vault master key. Even so, only enable Host mode on a box you're comfortable handing a full shell to.

## Config keys

Most people never touch these directly; `onboard` writes the ones that matter. Full list in `.env.example`.

| Key | What it does |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot token |
| `TELEGRAM_ALLOWED_USERNAMES` / `..._USER_IDS` | who's allowed in (empty means anyone); an allowed handle's id is pinned to `..._USER_IDS` on first message |
| `PORT` | server port (default 40002) |
| `HOST_MODE` | allow Host pods — unsandboxed shell on the bot machine (default `false`) |
| `MINIAPP_URL` | public origin for the mini app; `start` fills this from the tunnel |
| `PAIRPOD_PUBLIC_URL` | where SSH Claude sessions send notifications; defaults to `MINIAPP_URL` |
| `PAIRPOD_VAULT_KEY` | vault master key |
| `PAIRPOD_HOME` | where state lives (default `~/.pairpod`) |

## Troubleshooting

- `ERR_DLOPEN_FAILED` or a `NODE_MODULE_VERSION` mismatch means you're not on Node 22. Switch (`nvm use 22`) and reinstall (`npm install -g pairpod`, or `pnpm install` in a clone).
- `posix_spawnp failed` on a Host session is node-pty's helper losing its execute bit. Reinstalling re-fixes it (a postinstall handles it).
- If the mini app looks stale after an update, Telegram has cached it. Fully close and reopen the web app.
- `could not run cloudflared`: install it, or run `pairpod start --no-tunnel` with your own URL.
- Old "Open" buttons that 404: Telegram bakes the URL into a message when it's sent, so after a new tunnel URL just re-run `/pods` to get fresh buttons.

## License

MIT
