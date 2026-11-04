// Builds `xdev-ptyd` and `xdev` and puts them where Tauri's `externalBin` looks for it
// (`src-tauri/binaries/<name>-<target triple>`). Runs as the before-dev and
// before-build command, which get the target from Tauri's environment.
//
// Only `tauri build --config src-tauri/tauri.ptyd.conf.json` bundles it: the
// `externalBin` is kept out of tauri.conf.json, since the desktop crate's
// build script would then need the binary for every cargo build and test. A
// bundle made without that config has no terminal service, and the app says
// so when the setting is on.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const debug = process.env.TAURI_ENV_DEBUG !== "false";
const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!triple) throw new Error("no target triple");
const exe = triple.includes("windows") ? ".exe" : "";

// Two sidecars, both kept out of tauri.conf.json for the same reason:
// `xdev-ptyd` (the terminal service) and `xdev` (the CLI, so the app's
// terminals can run `xdev orchestration …` from `XDEV_CLI` or PATH).
const sidecars = [
  { pkg: "xdev-pty", bin: "xdev-ptyd" },
  { pkg: "xdev-cli", bin: "xdev" },
];

// Cargo's own answer, so CARGO_TARGET_DIR and `build.target-dir` count.
let target;
const out = join(here, "../src-tauri/binaries");
mkdirSync(out, { recursive: true });

for (const { pkg, bin } of sidecars) {
  const args = ["build", "-p", pkg, "--bin", bin, "--locked"];
  if (!debug) args.push("--release");
  if (triple !== host) args.push("--target", triple);
  execFileSync("cargo", args, { cwd: root, stdio: "inherit" });

  target ??= JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ).target_directory;
  const profile = debug ? "debug" : "release";
  const built = join(target, ...(triple !== host ? [triple] : []), profile, `${bin}${exe}`);
  copyFileSync(built, join(out, `${bin}-${triple}${exe}`));
}
