// Builds `xdev-ptyd` and puts it where Tauri's `externalBin` looks for it
// (`src-tauri/binaries/xdev-ptyd-<target triple>`). Runs as the before-dev and
// before-build command, which get the target from Tauri's environment.
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

const args = ["build", "-p", "xdev-pty", "--bin", "xdev-ptyd", "--locked"];
if (!debug) args.push("--release");
if (triple !== host) args.push("--target", triple);
execFileSync("cargo", args, { cwd: root, stdio: "inherit" });

const profile = debug ? "debug" : "release";
const built = join(root, "target", ...(triple !== host ? [triple] : []), profile, `xdev-ptyd${exe}`);
const out = join(here, "../src-tauri/binaries");
mkdirSync(out, { recursive: true });
copyFileSync(built, join(out, `xdev-ptyd-${triple}${exe}`));
