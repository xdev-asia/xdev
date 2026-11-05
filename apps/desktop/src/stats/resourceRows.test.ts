import { expect, it } from "vitest";
import { formatBytes, formatCpu, sortRows } from "./resourceRows";

const row = (tabId: string, memoryBytes: number) => ({ tabId, pid: 1, cpu: 0, memoryBytes, processes: 1 });

it("sorts by memory, largest first, and ties by tab id", () => {
  const rows = [row("b", 5), row("a", 5), row("c", 9), row("d", 1)];
  expect(sortRows(rows).map((r) => r.tabId)).toEqual(["c", "a", "b", "d"]);
  expect(rows[0].tabId).toBe("b");
});

it("formats bytes and CPU", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
  expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  expect(formatCpu(3.14159)).toBe("3.1%");
});
