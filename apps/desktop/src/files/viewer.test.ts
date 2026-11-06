import { describe, expect, it } from "vitest";
import { formatBytes, mimeOf, viewerOf } from "./viewer";

describe("viewerOf", () => {
  it("opens markdown files in the markdown view", () => {
    expect(viewerOf("docs/a.md", "text")).toBe("markdown");
    expect(viewerOf("a.MARKDOWN", "text")).toBe("markdown");
  });

  it("opens images as images even when the file reads as binary", () => {
    for (const rel of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp", "g.ico", "h.avif"]) {
      expect(viewerOf(rel, "binary")).toBe("image");
      expect(viewerOf(rel)).toBe("image");
    }
  });

  it("opens svg as an image only once it is known to be small enough", () => {
    expect(viewerOf("a.svg")).toBe("text");
    expect(viewerOf("a.svg", "text")).toBe("image");
    expect(viewerOf("a.svg", "tooLarge")).toBe("text");
  });

  it("opens audio and video in the media view", () => {
    for (const rel of ["a.mp3", "a.wav", "a.ogg", "a.oga", "a.m4a", "a.flac", "v.mp4", "v.webm", "v.ogv", "v.MOV"]) {
      expect(viewerOf(rel, "binary")).toBe("media");
    }
  });

  it("opens pdf in the pdf view whatever the read said", () => {
    expect(viewerOf("docs/A.PDF")).toBe("pdf");
    expect(viewerOf("a.pdf", "binary")).toBe("pdf");
    expect(viewerOf("a.pdf.txt")).toBe("text");
    expect(mimeOf("a.pdf")).toBe("application/pdf");
  });

  it("keeps the binary note for other binary files and the editor for text", () => {
    expect(viewerOf("a.zip", "binary")).toBe("binary");
    expect(viewerOf("a.ts", "text")).toBe("text");
    expect(viewerOf("Makefile", "text")).toBe("text");
    expect(viewerOf("a.md", "binary")).toBe("binary");
  });
});

describe("viewerOf tables and notebooks", () => {
  it("opens csv, tsv and ipynb in their view once the read found text", () => {
    expect(viewerOf("a.csv", "text")).toBe("csv");
    expect(viewerOf("d/B.TSV", "text")).toBe("csv");
    expect(viewerOf("n.ipynb", "text")).toBe("notebook");
  });

  it("reads them as text first, and keeps the binary note and the editor for the rest", () => {
    expect(viewerOf("a.csv")).toBe("text");
    expect(viewerOf("n.ipynb")).toBe("text");
    expect(viewerOf("a.csv", "binary")).toBe("binary");
    expect(viewerOf("n.ipynb", "tooLarge")).toBe("text");
    expect(viewerOf("a.csvx", "text")).toBe("text");
  });
});

describe("mimeOf", () => {
  it("maps extensions to a type, ignoring case", () => {
    expect(mimeOf("a.PNG")).toBe("image/png");
    expect(mimeOf("a.jpg")).toBe("image/jpeg");
    expect(mimeOf("a.svg")).toBe("image/svg+xml");
    expect(mimeOf("a.mp3")).toBe("audio/mpeg");
    expect(mimeOf("a.mov")).toBe("video/quicktime");
    expect(mimeOf("a.xyz")).toBe("application/octet-stream");
  });
});

describe("formatBytes", () => {
  it("uses B, KB and MB with one decimal above bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MB");
  });
});
