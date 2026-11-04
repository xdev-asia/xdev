import type { Terminal as XTerm } from "@xterm/xterm";

/** What the program asked for, per xterm buffer. */
export interface InputModes {
  /** Kitty keyboard flags of the active screen. */
  kittyFlags(): number;
  /** The modifyOtherKeys level the program set. */
  modifyOtherKeys(): number;
  /** Forget everything: the program that set it is gone. */
  reset(): void;
  dispose(): void;
}

const STACK_CAP = 16;

type Screen = { flags: number; stack: number[] };
type Params = (number | number[])[];

const num = (p: Params, i: number, fallback: number): number => {
  const v = p[i];
  const n = Array.isArray(v) ? v[0] : v;
  return n === undefined || n < 0 ? fallback : n;
};

/**
 * Follows the kitty keyboard flags (`CSI > / < / = u`) and modifyOtherKeys (`CSI > 4 ; n m`) a
 * program sets. Every handler returns false so xterm still runs its own; the `CSI ? u` query is
 * not answered, because xterm cannot produce the full kitty encoding a program would then expect.
 */
export function trackInputModes(term: Pick<XTerm, "parser"> & { buffer: Pick<XTerm["buffer"], "active"> & Partial<Pick<XTerm["buffer"], "onBufferChange">> }): InputModes {
  const screens: Record<string, Screen> = {};
  let mok = 0;
  const screen = (): Screen => (screens[term.buffer.active.type] ??= { flags: 0, stack: [] });
  const clear = () => {
    for (const k of Object.keys(screens)) delete screens[k];
    mok = 0;
  };
  const reset = () => {
    clear();
    return false;
  };
  // A program that enters the alternate screen starts from nothing; one that died there left its flags behind.
  const bufferChange = term.buffer.onBufferChange?.((b) => {
    if (b.type === "alternate") delete screens.alternate;
  });

  const handlers = [
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (p) => {
      const s = screen();
      s.stack.push(s.flags);
      if (s.stack.length > STACK_CAP) s.stack.shift();
      s.flags = num(p, 0, 0);
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (p) => {
      const s = screen();
      const n = Math.max(1, num(p, 0, 1));
      let restored = 0;
      for (let i = 0; i < n; i++) restored = s.stack.pop() ?? 0;
      s.flags = restored;
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (p) => {
      const s = screen();
      const flags = num(p, 0, 0);
      const mode = num(p, 1, 1);
      if (mode === 1) s.flags = flags;
      else if (mode === 2) s.flags |= flags;
      else if (mode === 3) s.flags &= ~flags;
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: ">", final: "m" }, (p) => {
      if (num(p, 0, -1) === 4) mok = num(p, 1, 0);
      return false;
    }),
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, reset),
    term.parser.registerEscHandler({ final: "c" }, reset),
  ];

  return {
    kittyFlags: () => screen().flags,
    modifyOtherKeys: () => mok,
    reset: clear,
    dispose: () => {
      handlers.forEach((h) => h.dispose());
      bufferChange?.dispose();
    },
  };
}
