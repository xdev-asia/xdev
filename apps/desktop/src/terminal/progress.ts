/**
 * Reads the data of an OSC 9 sequence as a progress report (`4;state;percent`).
 * A number is the percent (0-100), null clears it, "keep" leaves the value as it is,
 * and undefined means this is not a progress report (OSC 9 also carries plain notification text).
 */
export function parseOsc9Progress(data: string): number | null | "keep" | undefined {
  const m = /^4;([0-4])(?:;(\d{1,6}))?$/.exec(data);
  if (!m) return undefined;
  switch (m[1]) {
    case "0": return null;
    case "1": return m[2] === undefined ? undefined : Math.min(100, Number(m[2]));
    default: return "keep";
  }
}
