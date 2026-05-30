#!/usr/bin/env node
import { onboard } from "./onboard.js";
import { start } from "./start.js";

const HELP = `pairpod — run terminals & Claude sessions from Telegram

Usage:
  pairpod onboard                 Configure the bot (token, allowlist, port, vault key)
  pairpod start                   Start the tunnel + bot (one command)
  pairpod start --no-tunnel       Start the bot only (use the existing MINIAPP_URL)
  pairpod start --host-mode true  Allow host pods this run (a shell on the bot machine)

Config lives in ~/.pairpod/ (override with PAIRPOD_HOME).`;

function hostModeFlag(args: string[]): string | undefined {
  const i = args.findIndex((a) => a === "--host-mode" || a.startsWith("--host-mode="));
  if (i === -1) return undefined;
  const arg = args[i];
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
  if (value !== "true" && value !== "false") {
    console.error("--host-mode expects true or false");
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "onboard":
      await onboard();
      break;
    case "start":
      await start(!rest.includes("--no-tunnel"), hostModeFlag(rest));
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
