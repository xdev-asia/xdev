import type { ResourceRow } from "@/api";

/** Largest memory first; equal memory keeps the tab id order so rows do not jump between reads. */
export function sortRows(rows: readonly ResourceRow[]): ResourceRow[] {
  return [...rows].sort((a, b) => b.memoryBytes - a.memoryBytes || (a.tabId ?? "").localeCompare(b.tabId ?? ""));
}

/** `1.5 GB`, `120 MB`, `64 KB`, `0 B`: binary units, one decimal under 10. */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i > 0 && v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${text} ${units[i]}`;
}

/** `3.2%`; CPU is the share of one core, so it can pass 100. */
export function formatCpu(p: number): string {
  return `${p.toFixed(1)}%`;
}
