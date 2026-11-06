import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { LICENSE_PLUMBING, PRO_SURFACES } from "./proSurfaces";

const SRC = join(__dirname, "..");
const GATE = /\bProGate\b|\ballows\(|\blicenseAllows\(/;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(e.name)) out.push(relative(SRC, path).split(sep).join("/"));
  }
  return out;
}

describe("free features are never gated", () => {
  const allowed = new Set([...Object.values(PRO_SURFACES).flat(), ...LICENSE_PLUMBING]);
  const files = sources(SRC);

  it("walks the source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("only a listed Pro surface asks the license", () => {
    const offenders = files.filter((f) => !allowed.has(f) && GATE.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every listed Pro surface exists and gates", () => {
    for (const [feature, list] of Object.entries(PRO_SURFACES)) {
      for (const f of list) {
        expect(files, `${feature}: ${f}`).toContain(f);
        expect(readFileSync(join(SRC, f), "utf8"), `${feature}: ${f}`).toMatch(GATE);
      }
    }
  });
});
