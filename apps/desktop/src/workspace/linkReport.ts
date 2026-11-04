import type { Linked } from "@/api";

/** The shared paths that did not link, each as `path: why`; empty when all did. */
export function failedLinks(linked: readonly Linked[]): string[] {
  return linked.filter((l) => !l.ok).map((l) => (l.error ? `${l.path}: ${l.error}` : l.path));
}
