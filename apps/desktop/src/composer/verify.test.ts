import { describe, expect, it } from "vitest";
import { CONFIRM_MS, decide, retryTargets, typedBytes, verifiedSend, type SendDeps } from "./verify";

describe("decide", () => {
  const first = { enter: 1 as const, baseline: 100, enterAt: 1000 };

  it("output after Enter is sent", () => {
    expect(decide(first, 101, 1001)).toBe("sent");
    expect(decide({ ...first, baseline: null }, 5, 1001)).toBe("sent");
  });

  it("waits until the bound, then retries once, then gives up", () => {
    expect(decide(first, 100, 1000 + CONFIRM_MS - 1)).toBe("wait");
    expect(decide(first, 100, 1000 + CONFIRM_MS)).toBe("retry");
    expect(decide({ ...first, enter: 2 }, 100, 1000 + CONFIRM_MS)).toBe("unconfirmed");
    expect(decide({ ...first, baseline: null }, null, 1000 + CONFIRM_MS)).toBe("retry");
  });
});

describe("typedBytes", () => {
  it("pastes for an agent without the Enter", () => {
    expect(typedBytes("a\nb", true)).toBe("\x1b[200~a\nb\x1b[201~");
  });

  it("types lines for a shell and drops controls", () => {
    expect(typedBytes("ls\npwd\x1b", false)).toBe("ls\rpwd");
  });
});

/** A fake clock and tab: `replyAfter` lists, per Enter, whether the tab prints something. */
function fakeTab(replies: boolean[], failWrite = false) {
  let now = 0;
  let last: number | null = null;
  const writes: string[] = [];
  let enters = 0;
  const deps: SendDeps = {
    async write(data) {
      if (failWrite) throw new Error("gone");
      writes.push(data);
      if (data === "\r") {
        if (replies[enters]) last = now + 1;
        enters++;
      }
    },
    lastOutput: () => last,
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  return { deps, writes };
}

describe("verifiedSend", () => {
  it("is sent when the first Enter gets a reply", async () => {
    const tab = fakeTab([true]);
    expect(await verifiedSend("hi", true, tab.deps)).toBe("sent");
    expect(tab.writes.filter((w) => w === "\r")).toHaveLength(1);
  });

  it("presses Enter once more when the first gets nothing", async () => {
    const tab = fakeTab([false, true]);
    expect(await verifiedSend("hi", false, tab.deps)).toBe("sent");
    expect(tab.writes).toEqual(["hi", "\r", "\r"]);
  });

  it("is unconfirmed after two silent Enters and does not retry again", async () => {
    const tab = fakeTab([false, false, true]);
    expect(await verifiedSend("hi", false, tab.deps)).toBe("unconfirmed");
    expect(tab.writes.filter((w) => w === "\r")).toHaveLength(2);
  });

  it("is failed when the write fails", async () => {
    expect(await verifiedSend("hi", false, fakeTab([], true).deps)).toBe("failed");
  });
});

it("retryTargets keeps the unconfirmed and failed tabs", () => {
  expect(retryTargets({ a: "sent", b: "unconfirmed", c: "failed" })).toEqual(["b", "c"]);
});
