import type { WorkItem, WorkItemKind } from "@/api";

/** The link a person typed: nothing, a usable item, or a link the app cannot take. */
export function parseItem(url: string, kind: WorkItemKind): WorkItem | null | "bad" {
  const text = url.trim();
  if (text === "") return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "bad";
  } catch {
    return "bad";
  }
  return { kind, url: text, title: null };
}
