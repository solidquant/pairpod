# pairpod

Run terminals and Claude Code sessions from your phone, through a Telegram bot.

Point pairpod at a backend (a Docker container, an SSH host, or the machine the bot runs on) and it gives you a real terminal inside a Telegram mini app. Start a plain shell or a Claude Code session, attach from anywhere, scroll, copy, pinch to zoom. It's xterm over a WebSocket, so it behaves the way you'd expect.

## Concepts

A **pod** is a backend. A **session** is a terminal running on it.

Pods come in three kinds:

| | |
|---|---|
| 🐳 Docker | a throwaway, isolated container on the bot host |
| 🔌 SSH | a remote machine reached over SSH |
| 💻 Host | a shell on the bot machine itself |

Sessions come in three modes:

| | |
|---|---|
| terminal | a plain shell |
| regular | `claude` — you answer the permission prompts |
| skip-perms | `claude --dangerously-skip-permissions` |

Docker and SSH pods run all three modes; Host pods are terminal-only. You can name pods and sessions, which keeps a list of `pod-7` / `claude-3` readable once you have a few.

## Quick start

You'll need Node 22, pnpm, and [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`). Docker is optional; only Docker pods touch it.

```bash
nvm use
pnpm install
pnpm onboard     # asks for a bot token, allowed users, and a port
pnpm start       # opens the tunnel and starts the bot together
```

`onboard` points you at [@BotFather](https://t.me/BotFather) to create a bot, then writes everything to `~/.pairpod/.env` and generates a vault key for you. `start` brings up a cloudflared tunnel, points the bot at its URL, and runs both. One command, and Ctrl-C stops everything.

Then message your bot `/pods`, create one, and tap ▶ to open a terminal.

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

On the command line (`pairpod <cmd>` once installed, or `pnpm <cmd>` in the repo):

- `onboard` — write `~/.pairpod/.env`
- `start` — tunnel plus bot
- `start --no-tunnel` — bot only, using a `MINIAPP_URL` you set yourself
- `dev` — hot-reload the bot, no tunnel (for development)
- `build` — compile both packages to `dist/`

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

Docker pods are isolated. SSH pods are a separate machine. A Host pod, though, is an un-sandboxed shell on the bot machine (vault key in memory included), so only enable it somewhere you're comfortable handing out that access. Either way the bot only answers people on your allowlist, and the mini app checks Telegram's signed `initData` on every connection.

## Config keys

Most people never touch these directly; `onboard` writes the ones that matter. Full list in `.env.example`.

| Key | What it does |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot token |
| `TELEGRAM_ALLOWED_USERNAMES` / `..._USER_IDS` | who's allowed in (empty means anyone) |
| `PORT` | server port (default 40002) |
| `MINIAPP_URL` | public origin for the mini app; `start` fills this from the tunnel |
| `PAIRPOD_PUBLIC_URL` | where SSH Claude sessions send notifications; defaults to `MINIAPP_URL` |
| `PAIRPOD_VAULT_KEY` | vault master key |
| `PAIRPOD_HOME` | where state lives (default `~/.pairpod`) |

## Troubleshooting

- `ERR_DLOPEN_FAILED` or a `NODE_MODULE_VERSION` mismatch means you're not on Node 22. Run `nvm use`.
- `posix_spawnp failed` on a Host session is node-pty's helper losing its execute bit. `pnpm install` re-fixes it (a postinstall handles it).
- If the mini app looks stale after an update, Telegram has cached it. Fully close and reopen the web app.
- `could not run cloudflared`: install it, or run `pairpod start --no-tunnel` with your own URL.
- Old "Open" buttons that 404: Telegram bakes the URL into a message when it's sent, so after a new tunnel URL just re-run `/pods` to get fresh buttons.

## License

MIT
