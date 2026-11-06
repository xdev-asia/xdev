import { afterEach, expect, it } from "vitest";
import type { TerminalHandle } from "./Terminal";
import { registerTerminalHandle, terminalHandleAt, unregisterTerminalHandle, type NodeLike } from "./handleRegistry";

const node = (parentElement: NodeLike | null = null): NodeLike => ({ parentElement });
const handle = () => ({ focus: () => {} }) as unknown as TerminalHandle;

const registered: NodeLike[] = [];
afterEach(() => {
  for (const el of registered.splice(0)) unregisterTerminalHandle(el);
});

it("finds the handle of the terminal a node sits in, and forgets it on unregister", () => {
  const host = node();
  const h = handle();
  registerTerminalHandle(host, h);
  registered.push(host);
  const child = node(node(host));
  expect(terminalHandleAt(child)).toBe(h);
  expect(terminalHandleAt(host)).toBe(h);
  unregisterTerminalHandle(host);
  expect(terminalHandleAt(child)).toBeNull();
});

it("a node outside every terminal has no handle", () => {
  expect(terminalHandleAt(node())).toBeNull();
  expect(terminalHandleAt(null)).toBeNull();
});

it("unregister with a stale handle keeps the newer one", () => {
  const host = node();
  const first = handle();
  const second = handle();
  registerTerminalHandle(host, first);
  registerTerminalHandle(host, second);
  registered.push(host);
  unregisterTerminalHandle(host, first);
  expect(terminalHandleAt(host)).toBe(second);
});
