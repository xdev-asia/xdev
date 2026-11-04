import { expect, it, vi } from "vitest";
import { startAgentsReport, type ReportSource } from "./keepAwake";

/** A source whose list of working agent tabs the test sets by hand. */
function source() {
  let working = 0;
  const listeners = new Set<() => void>();
  const src: ReportSource = {
    workingAgents: () => working,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    src,
    set(n: number) {
      working = n;
      for (const l of [...listeners]) l();
    },
    listeners,
  };
}

it("reports only when 'an agent is working' changes", () => {
  const s = source();
  const report = vi.fn();
  startAgentsReport(s.src, report);
  expect(report).not.toHaveBeenCalled();
  s.set(1);
  s.set(2);
  s.set(1);
  expect(report.mock.calls).toEqual([[true]]);
  s.set(0);
  s.set(0);
  expect(report.mock.calls).toEqual([[true], [false]]);
  s.set(3);
  expect(report.mock.calls).toEqual([[true], [false], [true]]);
});

it("reports true at once when an agent already works at start", () => {
  const s = source();
  s.set(1);
  const report = vi.fn();
  startAgentsReport(s.src, report);
  expect(report.mock.calls).toEqual([[true]]);
});

it("dispose stops the reports and says nothing is working", () => {
  const s = source();
  const report = vi.fn();
  const stop = startAgentsReport(s.src, report);
  s.set(1);
  stop();
  expect(s.listeners.size).toBe(0);
  expect(report.mock.calls).toEqual([[true], [false]]);
  s.set(0);
  s.set(1);
  expect(report).toHaveBeenCalledTimes(2);
});

it("a failing report does not break the loop", () => {
  const s = source();
  const report = vi.fn(() => {
    throw new Error("no");
  });
  startAgentsReport(s.src, report);
  expect(() => s.set(1)).not.toThrow();
});
