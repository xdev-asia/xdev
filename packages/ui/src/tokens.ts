import tokens from "../tokens.json";

export { tokens };

type Vars = Record<string, string>;

function prefixed(group: string, values: Record<string, string>): Vars {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [`--x-${group}-${k}`, v]));
}

function block(selector: string, vars: Vars): string {
  return `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join("")}}`;
}

export function tokensCss(): string {
  const light = {
    ...prefixed("color", tokens.color.light),
    // Neutrals of the workspace shell: cool grays here, near-black in dark mode. The semantic
    // colors stay in `color`.
    ...prefixed("graphite", tokens.graphite.light),
    ...prefixed("space", tokens.space),
    ...prefixed("radius", tokens.radius),
    ...prefixed("font", tokens.font),
    "color-scheme": "light",
  };
  const dark = {
    ...prefixed("color", tokens.color.dark),
    ...prefixed("graphite", tokens.graphite.dark),
    "color-scheme": "dark",
  };
  // Follow the OS by default, but let an explicit data-theme win either way.
  return [
    block(":root", light),
    `@media (prefers-color-scheme: dark){${block(':root:not([data-theme="light"])', dark)}}`,
    block(':root[data-theme="dark"]', dark),
  ].join("\n");
}
