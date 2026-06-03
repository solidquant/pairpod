export type Role = "owner" | "writer" | "reader";

export function canWrite(role: Role | null): boolean {
  return role === "owner" || role === "writer";
}

export function canRead(role: Role | null): boolean {
  return role !== null;
}

export function isGrantRole(s: string): s is "writer" | "reader" {
  return s === "writer" || s === "reader";
}
