import { expect, it, vi } from "vitest";
import { followAppTheme, TERMINAL_TOKENS } from "./terminalColors";

it("re-reads the terminal variables on a theme change and stops after unsubscribe", () => {
  let fire = () => {};
  let stopped = false;
  const make = (cb: () => void) => {
    fire = cb;
    return { observe() {}, disconnect: () => void (stopped = true) };
  };
  const values: Record<string, string> = { "--x-color-surface": "surface-1", "--x-color-ink": "ink-1" };
  const root = { setAttribute() {}, getAttribute: () => "light" } as unknown as Element & { setAttribute(): void; getAttribute(n: string): string | null };
  const seen: (string | undefined)[][] = [];
  const asked: string[] = [];
  const off = followAppTheme(
    {} as Element,
    (token) => seen.push(TERMINAL_TOKENS.map(token)),
    root,
    make,
    () => ({ getPropertyValue: (n: string) => (asked.push(n), values[n] ?? "") }),
  );
  expect(seen).toEqual([]);
  fire();
  values["--x-color-surface"] = "surface-2";
  fire();
  // An unset variable reads as undefined, so the caller falls back to its own default.
  expect(seen).toEqual([
    [undefined, "surface-1", "ink-1"],
    [undefined, "surface-2", "ink-1"],
  ]);
  expect(asked).toContain("--x-color-ink");
  off();
  expect(stopped).toBe(true);
});

it("does nothing without a DOM", () => {
  const apply = vi.fn();
  const off = followAppTheme({} as Element, apply, undefined);
  off();
  expect(apply).not.toHaveBeenCalled();
});
