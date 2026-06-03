// Live viewer count per session: every /attach socket registers here, and the current count is
// pushed to all viewers of that session as a {type:"viewers"} control frame whenever it changes.
interface ViewerSocket {
  send(data: string): void;
  readyState: number;
  OPEN: number;
}

const sessions = new Map<string, Set<ViewerSocket>>();

function broadcast(key: string): void {
  const set = sessions.get(key);
  if (!set) return;
  const msg = JSON.stringify({ type: "viewers", n: set.size });
  for (const s of set) {
    try {
      if (s.readyState === s.OPEN) s.send(msg);
    } catch {}
  }
}

export function addViewer(key: string, socket: ViewerSocket): void {
  let set = sessions.get(key);
  if (!set) {
    set = new Set();
    sessions.set(key, set);
  }
  set.add(socket);
  broadcast(key);
}

export function removeViewer(key: string, socket: ViewerSocket): void {
  const set = sessions.get(key);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) sessions.delete(key);
  else broadcast(key);
}
