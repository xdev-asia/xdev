import type { DefaultTab } from "@/api";
import { terminalBytes } from "@/quickCommands/run";
import type { Sessions, TabColor } from "./sessions";

// The hue in degrees each tab colour token sits at; c10 is the grey one.
const HUES: [TabColor, number][] = [
  ["c1", 0],
  ["c2", 25],
  ["c3", 42],
  ["c4", 145],
  ["c5", 175],
  ["c6", 220],
  ["c7", 255],
  ["c8", 270],
  ["c9", 325],
];

/** The tab colour token nearest to a `#rgb` or `#rrggbb` colour: by hue, grey when it has little colour; none when it is not a colour. */
export function tabColorOf(hex: string | null): TabColor {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "none";
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta < 0.12) return "c10";
  const hue = (max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60;
  const gap = (a: number, c: number) => Math.min(Math.abs(a - c), 360 - Math.abs(a - c));
  return HUES.reduce((best, h) => (gap(hue, h[1]) < gap(hue, best[1]) ? h : best))[0];
}

/** One shell tab per entry in `worktree`, named and coloured as the file says, with its command typed and run. */
export function openDefaultTabs(sessions: Sessions, worktree: string, tabs: readonly DefaultTab[], shell: string): void {
  for (const entry of tabs) {
    const tab = sessions.open(worktree, shell);
    sessions.rename(tab.id, entry.title);
    const color = tabColorOf(entry.color);
    if (color !== "none") sessions.setColor(tab.id, color);
    // A tab that is not on screen has no pty yet; the command waits for it, and the shell keeps typed-ahead input.
    tab.client.typeWhenReady(terminalBytes(entry.command, true));
  }
}
