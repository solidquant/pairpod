export type Role = "owner" | "writer-full" | "writer-chat" | "reader";
export type GrantRole = "writer-full" | "writer-chat" | "reader";

// Terminal write: write-attach, mini-app upload, create/kill/rename sessions.
export function canWrite(role: Role | null): boolean {
  return role === "owner" || role === "writer-full";
}

// Chat to a chat-mode session over Telegram (@handle text/images). writer-chat gets this but
// not terminal write — their mini-app terminal stays read-only.
export function canChat(role: Role | null): boolean {
  return role === "owner" || role === "writer-full" || role === "writer-chat";
}

export function canRead(role: Role | null): boolean {
  return role !== null;
}

export function isGrantRole(s: string): s is GrantRole {
  return s === "writer-full" || s === "writer-chat" || s === "reader";
}

// Accept friendly aliases in the grant text input.
export function normalizeGrantRole(s: string): GrantRole | null {
  const t = s.trim().toLowerCase();
  if (t === "writer-full" || t === "full" || t === "writer") return "writer-full";
  if (t === "writer-chat" || t === "chat") return "writer-chat";
  if (t === "reader" || t === "read") return "reader";
  return null;
}

// Cycle order for the one-tap role toggle in the Access view.
export function nextGrantRole(role: string): GrantRole {
  if (role === "reader") return "writer-chat";
  if (role === "writer-chat") return "writer-full";
  return "reader";
}
