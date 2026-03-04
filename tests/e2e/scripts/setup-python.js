#!/usr/bin/env node
/**
 * Cross-platform Python venv setup for e2e tests.
 * Creates .venv and installs requirements.txt on Linux, macOS, and Windows.
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const isWindows = process.platform === "win32";
const pythonBin = isWindows ? "python" : "python3";
const pipBin = isWindows
  ? path.join(root, ".venv", "Scripts", "pip")
  : path.join(root, ".venv", "bin", "pip");

console.log("Creating Python venv...");
execSync(`${pythonBin} -m venv .venv`, { cwd: root, stdio: "inherit" });

console.log("Installing Python dependencies...");
execSync(`"${pipBin}" install -r requirements.txt`, { cwd: root, stdio: "inherit" });

console.log("Python venv ready.");
