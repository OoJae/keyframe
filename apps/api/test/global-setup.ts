import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { anvilAvailable } from "./support/anvil.js";

// Build the e2e contracts once, before any test file starts (the anvil test files run in parallel workers).
export default function setup(): void {
  if (anvilAvailable())
    execFileSync("forge", ["build", "--root", join(import.meta.dirname, "e2e")], { stdio: "ignore" });
}
