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

it("no color literals in component sources", () => {
  const offenders: string[] = [];
  for (const { dir, ext } of roots) {
    const abs = join(repo, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs, { recursive: true }) as string[]) {
      if (!ext.test(file) || file.endsWith(".test.ts")) continue;
      readFileSync(join(abs, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (colorLiteral.test(line)) offenders.push(`${dir}/${file}:${i + 1}`);
        });
    }
  }
  expect(offenders).toEqual([]);
});
