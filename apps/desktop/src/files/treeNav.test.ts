import { expect, it } from "vitest";
import { navigate, type NavRow } from "./treeNav";

// docs/, src/ (open: lib/, App.tsx), README.md
const rows: NavRow[] = [
  { path: "docs", dir: true, open: false, depth: 0 },
  { path: "src", dir: true, open: true, depth: 0 },
  { path: "src/lib", dir: true, open: false, depth: 1 },
  { path: "src/App.tsx", dir: false, open: false, depth: 1 },
  { path: "README.md", dir: false, open: false, depth: 0 },
];

it("Up and Down move one row and stop at the ends", () => {
  expect(navigate(rows, "docs", "ArrowDown")).toEqual({ kind: "select", path: "src" });
  expect(navigate(rows, "src/App.tsx", "ArrowUp")).toEqual({ kind: "select", path: "src/lib" });
  expect(navigate(rows, "README.md", "ArrowDown")).toEqual({ kind: "select", path: "README.md" });
  expect(navigate(rows, "docs", "ArrowUp")).toEqual({ kind: "select", path: "docs" });
});

it("with nothing selected Down takes the first row and Up too", () => {
  expect(navigate(rows, null, "ArrowDown")).toEqual({ kind: "select", path: "docs" });
  expect(navigate(rows, null, "ArrowUp")).toEqual({ kind: "select", path: "docs" });
  expect(navigate(rows, "gone", "ArrowDown")).toEqual({ kind: "select", path: "docs" });
});

it("Home and End go to the first and last row", () => {
  expect(navigate(rows, "src", "Home")).toEqual({ kind: "select", path: "docs" });
  expect(navigate(rows, "src", "End")).toEqual({ kind: "select", path: "README.md" });
});

it("Right opens a closed folder, then moves into an open one, and does nothing on a file", () => {
  expect(navigate(rows, "docs", "ArrowRight")).toEqual({ kind: "expand", path: "docs" });
  expect(navigate(rows, "src", "ArrowRight")).toEqual({ kind: "select", path: "src/lib" });
  expect(navigate(rows, "README.md", "ArrowRight")).toBeNull();
  // An open folder with no rows below it (still loading) has nowhere to go.
  expect(navigate([{ path: "a", dir: true, open: true, depth: 0 }], "a", "ArrowRight")).toBeNull();
});

it("Left closes an open folder, else moves to the parent", () => {
  expect(navigate(rows, "src", "ArrowLeft")).toEqual({ kind: "collapse", path: "src" });
  expect(navigate(rows, "src/lib", "ArrowLeft")).toEqual({ kind: "select", path: "src" });
  expect(navigate(rows, "src/App.tsx", "ArrowLeft")).toEqual({ kind: "select", path: "src" });
  expect(navigate(rows, "README.md", "ArrowLeft")).toBeNull();
  expect(navigate(rows, "docs", "ArrowLeft")).toBeNull();
});

it("Enter opens a file and toggles a folder", () => {
  expect(navigate(rows, "README.md", "Enter")).toEqual({ kind: "open", path: "README.md" });
  expect(navigate(rows, "src", "Enter")).toEqual({ kind: "toggle", path: "src" });
});

it("an empty tree has nothing to do", () => {
  expect(navigate([], null, "ArrowDown")).toBeNull();
});

const long: NavRow[] = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}`, dir: false, open: false, depth: 0 }));

it("PageDown and PageUp jump a page and stop at the ends", () => {
  expect(navigate(long, "f3", "PageDown")).toEqual({ kind: "select", path: "f13" });
  expect(navigate(long, "f20", "PageDown")).toEqual({ kind: "select", path: "f24" });
  expect(navigate(long, "f13", "PageUp")).toEqual({ kind: "select", path: "f3" });
  expect(navigate(long, "f2", "PageUp")).toEqual({ kind: "select", path: "f0" });
  expect(navigate(long, null, "PageDown")).toEqual({ kind: "select", path: "f9" });
  expect(navigate(long, "f3", "PageDown", 4)).toEqual({ kind: "select", path: "f7" });
});

it("Space previews a file and toggles a folder; F2 renames", () => {
  expect(navigate(rows, "README.md", " ")).toEqual({ kind: "preview", path: "README.md" });
  expect(navigate(rows, "docs", " ")).toEqual({ kind: "toggle", path: "docs" });
  expect(navigate(rows, "README.md", "F2")).toEqual({ kind: "rename", path: "README.md" });
});
