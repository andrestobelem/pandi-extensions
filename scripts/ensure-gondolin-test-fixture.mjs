#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmInstallEnv } from "./setup-gondolin.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(repoRoot, ".pi", "tools-local", "gondolin");
const marker = path.join(fixtureDir, "node_modules", "@earendil-works", "gondolin", "dist", "src", "index.js");

if (existsSync(marker)) process.exit(0);

execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
	cwd: fixtureDir,
	env: npmInstallEnv(),
	stdio: "inherit",
});
