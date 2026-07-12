#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildPicanteInvocation({
	repoRoot = REPO_ROOT,
	args = [],
	env = process.env,
	platform = process.platform,
	nodeExecPath = process.execPath,
} = {}) {
	const configuredRoot = env.PI_CANTE_ROOT?.trim();
	const picanteRoot = configuredRoot ? resolve(repoRoot, configuredRoot) : resolve(repoRoot, "..", "pi-cante");
	const npmExecPath = env.npm_execpath?.trim();
	if (!npmExecPath && platform === "win32") {
		throw new Error("Cannot locate npm on Windows; run this command through npm run dev:picante.");
	}
	return {
		command: npmExecPath ? nodeExecPath : "npm",
		args: [...(npmExecPath ? [npmExecPath] : []), "run", "dev:picante", "--", ...args],
		cwd: picanteRoot,
		env: { ...env, PANDI_EXTENSIONS_ROOT: repoRoot },
	};
}

export function runPicante({
	repoRoot = REPO_ROOT,
	args = process.argv.slice(2),
	env = process.env,
	platform = process.platform,
	nodeExecPath = process.execPath,
	exists = existsSync,
	readFile = readFileSync,
	spawn = spawnSync,
} = {}) {
	const invocation = buildPicanteInvocation({ repoRoot, args, env, platform, nodeExecPath });
	const packageJsonPath = join(invocation.cwd, "package.json");
	if (!exists(packageJsonPath)) {
		throw new Error(`No pi-cante checkout found at ${invocation.cwd}. Clone it as a sibling or set PI_CANTE_ROOT.`);
	}
	let manifest;
	try {
		manifest = JSON.parse(readFile(packageJsonPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read the pi-cante manifest at ${packageJsonPath}.`, { cause: error });
	}
	if (typeof manifest.scripts?.["dev:picante"] !== "string") {
		throw new Error(`The checkout at ${invocation.cwd} does not declare a dev:picante script.`);
	}
	const result = spawn(invocation.command, invocation.args, {
		cwd: invocation.cwd,
		env: invocation.env,
		stdio: "inherit",
	});
	if (result.error) {
		throw new Error(`Failed to start Picante from ${invocation.cwd}: ${result.error.message}`, {
			cause: result.error,
		});
	}
	return result.status ?? 1;
}

function main() {
	try {
		process.exitCode = runPicante();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
