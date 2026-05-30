#!/usr/bin/env node
import { onboard } from "./onboard.js";
import { start } from "./start.js";

const HELP = `pairpod — run terminals & Claude sessions from Telegram

Usage:
  pairpod onboard              Configure the bot (token, allowlist, port, vault key)
  pairpod start                Start the tunnel + bot (one command)
  pairpod start --no-tunnel    Start the bot only (use the existing MINIAPP_URL)

Config lives in ~/.pairpod/ (override with PAIRPOD_HOME).`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "onboard":
      await onboard();
      break;
    case "start":
      await start(!rest.includes("--no-tunnel"));
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main();
