import type { ApiError } from "../api";

export type DocState = {
  path: string | null;
  saved: string;
  draft: string;
  status: "idle" | "loading" | "saving" | "conflict" | "error";
  error?: ApiError["code"];
  diskVersion?: string;
};

export type DocAction =
  | { type: "loadStarted"; path: string }
  | { type: "loaded"; path: string; content: string }
  | { type: "edited"; content: string }
  | { type: "saveStarted" }
  | { type: "saved"; content: string }
  | { type: "failed"; code: ApiError["code"] }
  | { type: "externalChange"; content: string }
  | { type: "resolveReload" }
  | { type: "resolveKeepMine" }
  | { type: "closed" };

export const initialDocState: DocState = { path: null, saved: "", draft: "", status: "idle" };

export function isDirty(s: DocState): boolean {
  return s.draft !== s.saved;
}

function externalChange(s: DocState, content: string): DocState {
  if (s.status === "conflict") {
    // The disk moved again: either it now agrees with one side, or it is the newer version to resolve against.
    if (content === s.draft || content === s.saved) {
      return { ...s, saved: content, status: "idle", diskVersion: undefined };
    }
    return { ...s, diskVersion: content };
  }
  // Our own write coming back from the watcher.
  if (content === s.saved) return s;
  // The disk caught up with the draft (e.g. the echo arrived before the save resolved), so nothing is lost.
  if (content === s.draft) return { ...s, saved: content };
  if (!isDirty(s)) return { ...s, saved: content, draft: content };
  return { ...s, status: "conflict", diskVersion: content };
}

export function docReducer(s: DocState, a: DocAction): DocState {
  switch (a.type) {
    case "loadStarted":
      return { path: a.path, saved: "", draft: "", status: "loading" };
    case "loaded":
      return { path: a.path, saved: a.content, draft: a.content, status: "idle" };
    case "edited":
      return { ...s, draft: a.content };
    case "saveStarted":
      return { ...s, status: "saving", error: undefined };
    case "saved":
      // A conflict raised while the write was in flight must survive it.
      return { ...s, saved: a.content, status: s.status === "saving" ? "idle" : s.status };
    case "failed":
      return { ...s, status: "error", error: a.code };
    case "externalChange":
      return externalChange(s, a.content);
    case "resolveReload":
      if (s.status !== "conflict") return s;
      return { ...s, saved: s.diskVersion ?? s.saved, draft: s.diskVersion ?? s.saved, status: "idle", diskVersion: undefined };
    case "resolveKeepMine":
      if (s.status !== "conflict") return s;
      // Treating the disk version as the base keeps the draft dirty, so the next save overwrites the disk.
      return { ...s, saved: s.diskVersion ?? s.saved, status: "idle", diskVersion: undefined };
    case "closed":
      return initialDocState;
  }
}
