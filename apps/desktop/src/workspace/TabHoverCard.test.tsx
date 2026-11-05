import type { ReactElement } from "react";
import { expect, it } from "vitest";
import { nodes, textOf } from "@/kit/testHooks";
import { TabHoverCard, tailLines } from "./TabHoverCard";

const card = (output?: string[]) =>
  TabHoverCard({
    id: "c",
    at: { x: 0, y: 0 },
    labels: { agent: "Agent", status: "Status", cwd: "Folder" },
    data: { title: "Fix login", agent: "Claude", status: "Working", cwd: "/repo" },
    output,
  }) as ReactElement;

const out = (el: ReactElement) => nodes(el).find((n) => n.props["data-tab-output"] !== undefined);

it("shows the output lines under the rows", () => {
  const box = out(card(["$ npm test", "ok"]))!;
  expect(box.props.className).toContain("ws-tab-card-out");
  expect(nodes(box.props.children).map(textOf)).toEqual(["$ npm test", "ok"]);
});

it("shows nothing extra when the tail is empty or unknown", () => {
  expect(out(card([]))).toBeUndefined();
  expect(out(card())).toBeUndefined();
});

it("keeps the last 8 lines and trims blank edges", () => {
  const text = "\n" + Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n \n";
  const lines = tailLines(text);
  expect(lines).toHaveLength(8);
  expect(lines[0]).toBe("line 5");
  expect(lines[7]).toBe("line 12");
  expect(tailLines("")).toEqual([]);
  expect(tailLines("a\r\nb\r\n")).toEqual(["a", "b"]);
});
