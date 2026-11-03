// Remove build output: Cargo's build directory, the UI bundle and packages.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

execFileSync("cargo", ["clean", "--manifest-path", "core/Cargo.toml"], { stdio: "inherit" });
for (const d of ["dist", "release", "core/bin", "core/target"]) rmSync(d, { recursive: true, force: true });
console.log("clean");
