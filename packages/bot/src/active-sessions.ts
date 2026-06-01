// Sessions with a live mini-app attachment right now. The notifier skips these:
// you're already looking at the terminal, so a permission/idle ping is just noise.
const active = new Map<string, number>();

function key(pod: string, session: string): string {
  return `${pod}:${session}`;
}

export function markActive(pod: string, session: string): void {
  const k = key(pod, session);
  active.set(k, (active.get(k) ?? 0) + 1);
}

export function markInactive(pod: string, session: string): void {
  const k = key(pod, session);
  const n = (active.get(k) ?? 0) - 1;
  if (n <= 0) active.delete(k);
  else active.set(k, n);
}

export function isActive(pod: string, session: string): boolean {
  return active.has(key(pod, session));
}
