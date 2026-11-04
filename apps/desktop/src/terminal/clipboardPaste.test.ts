import { describe, expect, it, vi } from "vitest";
import { pasteClipboard } from "./clipboardPaste";
import type { ShellKind } from "./pathPaste";

function deps(over: Partial<Parameters<typeof pasteClipboard>[0]> = {}) {
  return {
    readText: vi.fn(async () => ""),
    saveImage: vi.fn(async (): Promise<string | null> => null),
    pasteText: vi.fn(),
    writeRaw: vi.fn(async () => {}),
    shell: vi.fn((): ShellKind => "posix"),
    bracketedMode: vi.fn(() => true),
    ...over,
  };
}

describe("pasteClipboard", () => {
  it("text goes to pasteText and the image is never read", async () => {
    const d = deps({ readText: vi.fn(async () => "hello") });
    expect(await pasteClipboard(d)).toBe("text");
    expect(d.pasteText).toHaveBeenCalledWith("hello");
    expect(d.saveImage).not.toHaveBeenCalled();
    expect(d.writeRaw).not.toHaveBeenCalled();
  });

  it("empty text with an image writes the saved path as a forced bracketed paste", async () => {
    const d = deps({ saveImage: vi.fn(async () => "/tmp/xdev paste.png") });
    expect(await pasteClipboard(d)).toBe("image");
    expect(d.writeRaw).toHaveBeenCalledWith("\x1b[200~/tmp/xdev\\ paste.png\x1b[201~");
    expect(d.pasteText).not.toHaveBeenCalled();
  });

  it("with bracketed paste off the quoted path goes in plain with a trailing space", async () => {
    const d = deps({ saveImage: vi.fn(async () => "C:\\Users\\Mary Ann\\a.png"), shell: () => "powershell", bracketedMode: () => false });
    expect(await pasteClipboard(d)).toBe("image");
    expect(d.writeRaw).toHaveBeenCalledWith("'C:\\Users\\Mary Ann\\a.png' ");
  });

  it("a path that cannot be quoted for the shell is a failure and writes nothing", async () => {
    const d = deps({ saveImage: vi.fn(async () => "/tmp/a b.png"), shell: () => "unknown" });
    expect(await pasteClipboard(d)).toBe("failed");
    expect(d.writeRaw).not.toHaveBeenCalled();
  });

  it("unreadable text falls through to the image", async () => {
    const d = deps({
      readText: vi.fn(async () => Promise.reject(new Error("denied"))),
      saveImage: vi.fn(async () => "/tmp/a.png"),
    });
    expect(await pasteClipboard(d)).toBe("image");
  });

  it("nothing on the clipboard is empty", async () => {
    expect(await pasteClipboard(deps())).toBe("empty");
  });

  it("a too large image and any other failure are told apart", async () => {
    const big = deps({ saveImage: vi.fn(async () => Promise.reject({ code: "too_large" })) });
    expect(await pasteClipboard(big)).toBe("too_large");
    const bad = deps({ saveImage: vi.fn(async () => Promise.reject(new Error("io"))) });
    expect(await pasteClipboard(bad)).toBe("failed");
    expect(bad.writeRaw).not.toHaveBeenCalled();
  });

  it("a failing write of the path is a failure", async () => {
    const d = deps({
      saveImage: vi.fn(async () => "/tmp/a.png"),
      writeRaw: vi.fn(async () => Promise.reject(new Error("gone"))),
    });
    expect(await pasteClipboard(d)).toBe("failed");
  });
});
