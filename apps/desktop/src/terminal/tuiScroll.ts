export type MouseEncoding = "default" | "sgr" | "urxvt";
export interface WheelMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const MAX_REPORTS = 100;

/** One wheel report. col and row are 1-based. "" when the default encoding cannot carry the position (> 223). */
export function wheelReport(up: boolean, col: number, row: number, mods: WheelMods, enc: MouseEncoding): string {
  const b = (up ? 64 : 65) + (mods.shift ? 4 : 0) + (mods.alt ? 8 : 0) + (mods.ctrl ? 16 : 0);
  if (enc === "sgr") return `\x1b[<${b};${col};${row}M`;
  if (enc === "urxvt") return `\x1b[${b + 32};${col};${row}M`;
  if (col > 223 || row > 223) return "";
  return `\x1b[M${String.fromCharCode(32 + b, 32 + col, 32 + row)}`;
}

export interface TuiWheelDeps {
  /** `getTerminalSettings().tuiScrollSensitivity`. */
  speed(): number;
  /** `term.modes.mouseTrackingMode`. */
  trackingMode(): string;
  encoding(): MouseEncoding;
  cell(ev: WheelEvent): { col: number; row: number; height: number } | null;
  /** The pty input. */
  send(data: string): void;
}

/** For `term.attachCustomWheelEventHandler`: true lets xterm handle the event. */
export function createTuiWheelHandler(deps: TuiWheelDeps): (ev: WheelEvent) => boolean {
  let pixels = 0;
  return (ev) => {
    const speed = Math.round(deps.speed());
    if (!(speed > 1) || deps.trackingMode() === "none" || ev.deltaY === 0) return true;
    const cell = deps.cell(ev);
    if (!cell) return true;
    let steps: number;
    if (ev.deltaMode === 1) steps = Math.max(1, Math.round(Math.abs(ev.deltaY)));
    else if (ev.deltaMode === 2) steps = 1;
    else {
      pixels += ev.deltaY;
      const h = Math.max(1, cell.height);
      steps = Math.trunc(Math.abs(pixels) / h);
      pixels -= Math.sign(pixels) * steps * h;
    }
    const report = wheelReport(
      ev.deltaY < 0,
      cell.col,
      cell.row,
      { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey },
      deps.encoding(),
    );
    const count = Math.min(MAX_REPORTS, steps * speed);
    if (report && count > 0) deps.send(report.repeat(count));
    return false;
  };
}
