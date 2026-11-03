// Build the Rust core and copy the binary to core/bin/notez-core.
// Cargo's build directory lives outside the project (.cargo/config.toml
// or $CARGO_TARGET_DIR), so the project folder stays small.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const manifest = "core/Cargo.toml";
const profile = process.argv.includes("--debug") ? "debug" : "release";
execFileSync("cargo", ["build", ...(profile === "release" ? ["--release"] : []), "--manifest-path", manifest], { stdio: "inherit" });
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifest], { encoding: "utf8" }));
mkdirSync("core/bin", { recursive: true });
const exe = process.platform === "win32" ? ".exe" : "";
const dst = `core/bin/notez-core${exe}`;
rmSync(dst, { force: true });
copyFileSync(path.join(meta.target_directory, profile, `notez-core${exe}`), dst);
console.log(`core → ${dst} (build dir: ${meta.target_directory})`);
