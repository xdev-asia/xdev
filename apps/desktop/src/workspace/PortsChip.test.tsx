import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LivePort } from "./livePorts";
import { translate } from "@/i18n";
import { endpoint, PortsChip, PortsPopover, type PortsPopoverProps } from "./PortsChip";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
// The popover is called as a function to read its handlers, so its refs and effects are stubs.
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useRef: () => ({ current: null }), useEffect: () => {} }));

const node: LivePort = { id: "n", port: 5173, address: "127.0.0.1", endpoint: "127.0.0.1:5173", pid: 4242, process: "node" };
const bare: LivePort = { id: "b", port: 8080, address: "localhost", endpoint: "localhost:8080", pid: 77, process: null };
const six: LivePort = { id: "s", port: 3000, address: "::1", endpoint: "[::1]:3000", pid: 78, process: "python" };

function walk(el: unknown, out: ReactElement<Record<string, any>>[] = []): ReactElement<Record<string, any>>[] {
  if (Array.isArray(el)) el.forEach((e) => walk(e, out));
  else if (el && typeof el === "object" && "props" in el) {
    const e = el as ReactElement<Record<string, any>>;
    out.push(e);
    walk(e.props.children, out);
  }
  return out;
}
const base = (over: Partial<PortsPopoverProps> = {}): PortsPopoverProps => ({
  ports: [node, bare], at: { x: 10, y: 20 }, confirming: null,
  onOpenBrowser: vi.fn(), onCopy: vi.fn(), onAskStop: vi.fn(), onStop: vi.fn(), onClose: vi.fn(), ...over,
});
const action = (tree: unknown, name: string, row = 0) => walk(tree).filter((e) => e.props["data-action"] === name)[row];

it("the chip names the count, opens on click and is hidden at zero", () => {
  const open = vi.fn();
  expect(PortsChip({ count: 0, onOpen: open })).toBeNull();
  const el = PortsChip({ count: 2, onOpen: open }) as ReactElement<Record<string, any>>;
  expect(el.props["aria-label"]).toBe("2 live ports");
  el.props.onClick({ stopPropagation() {}, clientX: 5, clientY: 6 });
  expect(open).toHaveBeenCalledWith({ x: 5, y: 6 });
  expect(renderToStaticMarkup(el)).toContain("2");
});

it("the popover title counts the ports and each row shows port, process or PID, and address", () => {
  const html = renderToStaticMarkup(PortsPopover(base()));
  expect(html).toContain("Live ports (2)");
  expect(html).toContain("5173");
  expect(html).toContain("node - 127.0.0.1");
  expect(html).toContain("PID 77 - localhost");
  expect(html).toContain("Open in browser");
  expect(html).toContain("Copy 127.0.0.1:5173");
  expect(html).toContain("Stop process");
});

it("Open, Copy and the first Stop click act on their own row", () => {
  const props = base();
  const tree = PortsPopover(props);
  action(tree, "open", 1).props.onClick();
  action(tree, "copy", 0).props.onClick();
  action(tree, "stop", 1).props.onClick();
  expect(props.onOpenBrowser).toHaveBeenCalledWith(bare);
  expect(props.onCopy).toHaveBeenCalledWith(node);
  expect(props.onAskStop).toHaveBeenCalledWith(bare);
  expect(props.onStop).not.toHaveBeenCalled();
});

it("a Stop that asked first shows the confirmation, and only that click stops the process", () => {
  const props = base({ confirming: 4242 });
  const tree = PortsPopover(props);
  expect(renderToStaticMarkup(tree)).toContain("Stop process on 5173?");
  expect(action(tree, "stop", 0)).toBeDefined();
  action(tree, "stop-confirm", 0).props.onClick();
  expect(props.onStop).toHaveBeenCalledWith(node);
});

it("Escape and the backdrop close it", () => {
  const props = base();
  const tree = PortsPopover(props);
  const dialog = walk(tree).find((e) => e.props.role === "dialog")!;
  dialog.props.onKeyDown({ key: "Escape", preventDefault() {} });
  dialog.props.onKeyDown({ key: "a", preventDefault() {} });
  expect(props.onClose).toHaveBeenCalledTimes(1);
  walk(tree).find((e) => e.props["data-action"] === "ports-backdrop")!.props.onClick();
  expect(props.onClose).toHaveBeenCalledTimes(2);
});

it("an IPv6 address is bracketed in the copied endpoint", () => {
  expect(endpoint(six)).toBe("[::1]:3000");
  expect(endpoint(node)).toBe("127.0.0.1:5173");
});
