import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Raw colours live in packages/xdev-ui (tokens.json -> tokens.css); the app only uses the names.
const root = fileURLToPath(new URL("../", import.meta.url));
const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

it("no color literals in app sources", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.(ts|tsx|css)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (colorLiteral.test(line)) offenders.push(`${file.replaceAll("\\", "/")}:${i + 1}`);
      });
  }
  expect(offenders).toEqual([]);
});
