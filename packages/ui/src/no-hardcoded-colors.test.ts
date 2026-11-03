import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const roots = [
  { dir: "packages/ui/src", ext: /\.tsx$/ },
  { dir: "apps/desktop/src", ext: /\.(ts|tsx|css)$/ },
];
const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
// The desktop token sheet is the one place raw colors are defined; everything else uses its names.
const tokenSheets = new Set(["apps/desktop/src/styles/base.css"]);

it("no color literals in component sources", () => {
  const offenders: string[] = [];
  for (const { dir, ext } of roots) {
    const abs = join(repo, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs, { recursive: true }) as string[]) {
      const rel = `${dir}/${file.replaceAll("\\", "/")}`;
      if (!ext.test(file) || /\.test\.tsx?$/.test(file) || tokenSheets.has(rel)) continue;
      readFileSync(join(abs, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (colorLiteral.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
  }
  expect(offenders).toEqual([]);
});
