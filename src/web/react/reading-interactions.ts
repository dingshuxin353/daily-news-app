export type TodoAnchorResult =
  | { kind: "none" }
  | { kind: "valid"; id: string }
  | { kind: "invalid" };

export function parseTodoAnchorHash(hash: string): TodoAnchorResult {
  if (hash === "") return { kind: "none" };
  try {
    const id = decodeURIComponent(hash.startsWith("#") ? hash.slice(1) : hash);
    return id === "" ? { kind: "invalid" } : { kind: "valid", id };
  } catch {
    return { kind: "invalid" };
  }
}
