// node-pty ships a `spawn-helper` binary in its prebuilds; some package managers
// drop its execute bit on extraction, which makes Host PTY sessions fail with
// "posix_spawnp failed". Re-apply +x wherever node-pty actually landed.
const fs = require("node:fs");
const path = require("node:path");

try {
  const prebuilds = path.join(path.dirname(require.resolve("node-pty/package.json")), "prebuilds");
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {
  // node-pty not resolvable / not installed yet — nothing to fix.
}
