import { expect, it, vi } from "vitest";
import {
  MAX_PROMPTS,
  getShellMarks,
  installShellMarks,
  parseOsc133,
  promptLines,
  subscribeShellMarks,
  targetPromptLine,
} from "./shellMarks";

/** A stand-in xterm: the OSC 133 handler and markers that sit on `cursor`. */
function fakeTerm() {
  const state = { cursor: 0, handler: null as ((d: string) => boolean) | null, handlerGone: false };
  const markers: { line: number; isDisposed: boolean; dispose(): void }[] = [];
  const term = {
    parser: {
      registerOscHandler(id: number, cb: (d: string) => boolean) {
        expect(id).toBe(133);
        state.handler = cb;
        return { dispose: () => void (state.handlerGone = true) };
      },
    },
    registerMarker() {
      const m = {
        line: state.cursor,
        isDisposed: false,
        dispose() {
          m.isDisposed = true;
          m.line = -1;
        },
      };
      markers.push(m);
      return m;
    },
  };
  const send = (data: string) => state.handler!(data);
  const prompt = (line: number) => {
    state.cursor = line;
    send("A");
  };
  return { term, state, markers, send, prompt };
}

it("reads the four marks, an exit code and extra parameters", () => {
  expect(parseOsc133("A")).toEqual({ kind: "promptStart" });
  expect(parseOsc133("A;cl=m")).toEqual({ kind: "promptStart" });
  expect(parseOsc133("B")).toEqual({ kind: "commandStart" });
  expect(parseOsc133("C")).toEqual({ kind: "commandRun" });
  expect(parseOsc133("D;0")).toEqual({ kind: "commandEnd", exitCode: 0 });
  expect(parseOsc133("D;127;aid=4")).toEqual({ kind: "commandEnd", exitCode: 127 });
  expect(parseOsc133("D;-1")).toEqual({ kind: "commandEnd", exitCode: -1 });
  expect(parseOsc133("D")).toEqual({ kind: "commandEnd", exitCode: null });
  expect(parseOsc133("D;x")).toEqual({ kind: "commandEnd", exitCode: null });
  expect(parseOsc133("E;ls")).toBeNull();
  expect(parseOsc133("")).toBeNull();
});

it("finds the prompt before and after the top of the view", () => {
  const lines = [3, 40, 90];
  expect(targetPromptLine(lines, 60, -1)).toBe(40);
  expect(targetPromptLine(lines, 60, 1)).toBe(90);
  expect(targetPromptLine(lines, 40, -1)).toBe(3);
  expect(targetPromptLine(lines, 40, 1)).toBe(90);
  expect(targetPromptLine(lines, 3, -1)).toBeUndefined();
  expect(targetPromptLine(lines, 90, 1)).toBeUndefined();
  expect(targetPromptLine([], 10, -1)).toBeUndefined();
});

it("keeps the prompts, the running state and the last exit code of each terminal", () => {
  const { term, send, prompt } = fakeTerm();
  const seen = vi.fn();
  const off = subscribeShellMarks(seen);
  const forget = installShellMarks(term, "pty-a");
  expect(getShellMarks("pty-a")).toEqual({ exitCode: null, running: false, prompts: 0 });
  prompt(0);
  send("B");
  send("C");
  expect(getShellMarks("pty-a")).toEqual({ exitCode: null, running: true, prompts: 1 });
  send("D;3");
  prompt(5);
  expect(getShellMarks("pty-a")).toEqual({ exitCode: 3, running: false, prompts: 2 });
  expect(promptLines("pty-a")).toEqual([0, 5]);
  expect(getShellMarks("pty-b").prompts).toBe(0);
  // B changes nothing, so no listener runs for it.
  const calls = seen.mock.calls.length;
  send("B");
  expect(seen.mock.calls.length).toBe(calls);
  off();
  forget();
});

it("keeps one marker for a prompt drawn again on its line, drops trimmed and old ones", () => {
  const { term, markers, prompt } = fakeTerm();
  const forget = installShellMarks(term, "pty-c");
  prompt(2);
  prompt(2);
  expect(promptLines("pty-c")).toEqual([2]);
  expect(markers[0].isDisposed).toBe(true);
  prompt(8);
  // Scrollback trimmed past the prompt at 2.
  markers[1].dispose();
  expect(promptLines("pty-c")).toEqual([8]);
  for (let i = 0; i < MAX_PROMPTS + 5; i++) prompt(10 + i);
  const lines = promptLines("pty-c");
  expect(lines.length).toBe(MAX_PROMPTS);
  expect(lines[0]).toBe(15);
  forget();
});

it("forgets a terminal and its handler on cleanup, but not a newer view of the same pty", () => {
  const first = fakeTerm();
  const forgetFirst = installShellMarks(first.term, "pty-d");
  first.send("D;1");
  const second = fakeTerm();
  const forgetSecond = installShellMarks(second.term, "pty-d");
  second.send("D;4");
  forgetFirst();
  expect(first.state.handlerGone).toBe(true);
  expect(getShellMarks("pty-d").exitCode).toBe(4);
  forgetSecond();
  expect(getShellMarks("pty-d")).toEqual({ exitCode: null, running: false, prompts: 0 });
});
