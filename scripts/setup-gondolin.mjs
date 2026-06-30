#!/usr/bin/env node
/**
 * setup-gondolin.mjs — install the upstream Gondolin micro-VM isolation extension
 * into this repo's NON auto-discovered project-local tools dir (.pi/tools/gondolin)
 * so it is available on demand via `pi -e .pi/tools/gondolin`, without booting a VM
 * on every pi session.
 *
 * Why not vendor it (commit it): Gondolin needs a real runtime dependency
 * (@earendil-works/gondolin) with platform-specific native binaries, which would
 * bloat this repo's lockfile and only works on darwin-arm64 / linux-x64. We instead
 * copy pi's shipped example and install its deps with --ignore-scripts (the upstream
 * recommended, script-free install; the krun runner is a prebuilt binary and ssh2
 * falls back to pure JS without the optional cpu-features native build). The install
 * target .pi/tools/ is gitignored, so the heavy native deps stay out of version control.
 *
 * Why .pi/tools/ and NOT .pi/extensions/: a project-local .pi/extensions subdirectory
 * is auto-discovered and would load on every session (a micro-VM boot each time).
 * .pi/tools/ is not an auto-discovered path, so Gondolin loads only with an explicit `pi -e`.
 *
 * Usage:  node scripts/setup-gondolin.mjs   (or: npm run setup:gondolin)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED = new Set(["darwin-arm64", "linux-x64"]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(repoRoot, ".pi", "tools", "gondolin");

function fail(message) {
	console.error(`\n✖ ${message}\n`);
	process.exit(1);
}

// 1. Architecture guard: only platforms with a prebuilt krun runner are supported.
const platformKey = `${process.platform}-${process.arch}`;
if (!SUPPORTED.has(platformKey)) {
	fail(
		`Gondolin only ships prebuilt micro-VM runners for: ${[...SUPPORTED].join(", ")}.\n` +
			`  This host is "${platformKey}", which is unsupported and would crash at runtime.`,
	);
}

// 2. Node engine guard (@earendil-works/gondolin requires Node >= 23.6.0).
const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
if (major < 23 || (major === 23 && minor < 6)) {
	fail(`Gondolin requires Node >= 23.6.0; this is ${process.versions.node}.`);
}

// 3. Locate pi's shipped Gondolin example.
let globalRoot;
try {
	globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
} catch {
	fail("Could not run `npm root -g` to locate the global pi install.");
}
const example = path.join(globalRoot, "@earendil-works", "pi-coding-agent", "examples", "extensions", "gondolin");
if (!existsSync(path.join(example, "index.ts"))) {
	fail(
		`Could not find pi's Gondolin example at:\n  ${example}\n` +
			"  If you installed pi via brew/npx/bun, copy <pi>/examples/extensions/gondolin manually\n" +
			`  into ${target} and run: npm install --ignore-scripts`,
	);
}

// Refuse to clobber an existing install (e.g. one moved here manually).
if (existsSync(path.join(target, "index.ts"))) {
	console.log(`✓ Gondolin already installed at ${target} — nothing to do.`);
	process.exit(0);
}

// 4. Copy the (self-contained) example and install deps WITHOUT lifecycle scripts.
console.log(`→ Installing Gondolin into ${target}`);
mkdirSync(target, { recursive: true });
cpSync(example, target, { recursive: true });
// Strip inherited npm_config_* env so a parent `npm run` does not leak config
// (e.g. allow-scripts from ~/.npmrc -> npm_config_allow_scripts) into this
// nested install, which npm rejects together with --ignore-scripts (EALLOWSCRIPTS).
const childEnv = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")),
);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
	cwd: target,
	env: childEnv,
	stdio: "inherit",
});

console.log(
	[
		"",
		"✓ Gondolin installed (project-local, not auto-loaded).",
		"",
		"Use it on demand from this repo:",
		"  pi -e .pi/tools/gondolin",
		"",
		"Verify inside the session:  /gondolin   •   !uname -a (Linux)   •   !ls -la /workspace",
		"",
		"Note: Gondolin isolates built-in tools and ! commands inside the VM, but does NOT",
		"isolate dynamic-workflow subagent process spawns. See docs/gondolin-isolation.md.",
	].join("\n"),
);
