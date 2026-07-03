/**
 * Shared scaffolding for the durable integration suites under
 * extensions/<ext>/tests/integration/*.test.mjs.
 *
 * Owns the three things that were copy-pasted across the suites:
 *   - createChecker(): the PASS/FAIL reporter (counters + check()).
 *   - buildExtension(): the esbuild bootstrap that bundles an extension's entry
 *     (index.ts) to a tempdir ESM file with local stubs, so a suite runs with no
 *     install and never against a stale build.
 *   - loadDefault(): a cache-busting dynamic import of the bundled default export.
 *
 * What stays per-suite (genuinely divergent, NOT shared): the makePi()/makeCtx()
 * mocks, which encode each extension's API surface and the suite's assertions.
 * Folding those would couple unrelated contracts, so this module never touches them.
 *
 * Not published: these .mjs helpers fall outside the package "files" glob (which only
 * matches a single .ts under each extension dir) and live outside any tests/integration
 * suite dir, so run-all discovery never mistakes them for a suite. Imported from a suite as:
 *
 *   import { createChecker, buildExtension, loadDefault } from "../../../shared/test/harness.mjs";
 *
 * (suites sit at extensions/<ext>/tests/integration/, three levels below
 * extensions/shared/test/.)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Absolute repo root, derived from this file's location (extensions/shared/test/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Create an isolated PASS/FAIL reporter. Returns the `check` function plus a live
 * `counts` object ({ passed, failed, failures }) the suite reads in its summary.
 * Logging is byte-identical to the inline reporter it replaced.
 */
export function createChecker() {
	const counts = { passed: 0, failed: 0, failures: [] };
	function check(label, cond, detail) {
		if (cond) {
			counts.passed += 1;
			console.log(`PASS: ${label}`);
		} else {
			counts.failed += 1;
			counts.failures.push(label + (detail ? `  [${detail}]` : ""));
			console.log(`FAIL: ${label}${detail ? `  [${detail}]` : ""}`);
		}
	}
	return { check, counts };
}

/**
 * Cache-busting dynamic import of a freshly built ESM module. Each call appends a fresh
 * `?i=` query so re-imports of the same URL within a process always re-evaluate the
 * module (the suites rely on a clean extension instance). `loadModule` returns the full
 * namespace (for suites that read named exports); `loadDefault` returns `.default`.
 */
let loadCounter = 0;
export async function loadModule(url) {
	return await import(`${url}?i=${loadCounter++}`);
}
export async function loadDefault(url) {
	return (await loadModule(url)).default;
}

/**
 * Byte-identical client stubs shared across suites (verified identical in-tree before
 * extraction). The typebox stub is the SUPERSET (includes `Integer`); the few suites
 * that omitted it only gained an unused identity export, which cannot change behavior.
 */
export const STUB_SOURCES = {
	typebox:
		"const id = (x) => x ?? {};\n" +
		"export const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\n" +
		"export default { Type };\n",
	typeboxValue: "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n",
	ai: "export function StringEnum(values, opts = {}) { return { ...opts, enum: values }; }\n",
	tui:
		"export class Image { constructor() {} input() {} render() { return []; } }\n" +
		'export const Key = { escape: "escape", enter: "enter", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", delete: "delete", backspace: "backspace", tab: "tab", left: "left", right: "right", ctrlAlt: (key) => "ctrlAlt:" + key };\n' +
		"export function getCapabilities() { return { images: false }; }\n" +
		"export function matchesKey(data, key) { return data === key; }\n" +
		'export function truncateToWidth(value, width, suffix = "") { const s = String(value); return s.length > width ? s.slice(0, Math.max(0, width - suffix.length)) + suffix : s; }\n' +
		"export function visibleWidth(value) { return String(value).length; }\n" +
		'export class Markdown { constructor(text) { this.text = String(text == null ? "" : text); } render() { return this.text.split(/\\r?\\n/); } invalidate() {} }\n',
};

/**
 * Build the SDK (@earendil-works/pi-coding-agent) stub source. `getAgentDir()` points
 * at <outDir>/agentdir. `customEditor` adds a CustomEditor class shape:
 *   - "render": the render-only shape used by most workflow suites.
 *   - "full":   the getText/setText/handleInput/render/invalidate shape.
 */
export function sdkStub(outDir, { customEditor } = {}) {
	const agentDir = JSON.stringify(path.join(outDir, "agentdir"));
	let source = `export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${agentDir}; }\n`;
	if (customEditor === "render") {
		source += "export class CustomEditor { constructor() {} input() {} render() { return []; } }\n";
	} else if (customEditor === "full") {
		source +=
			'export class CustomEditor { constructor() {} getText() { return ""; } setText() {} handleInput() {} render() { return []; } invalidate() {} }\n';
	}
	return source;
}

const STUB_SPECIFIERS = {
	typebox: "typebox",
	typeboxValue: "typebox/value",
	ai: "@earendil-works/pi-ai",
	tui: "@earendil-works/pi-tui",
	sdk: "@earendil-works/pi-coding-agent",
};

/**
 * Write the requested stub files into `outDir` and return an esbuild `--alias` map
 * ({ "<module-specifier>": "<stub-file-path>" }).
 *
 * `spec` maps a stub key (typebox|typeboxValue|ai|tui|sdk) to:
 *   - true            → use the shared default source (STUB_SOURCES[key]).
 *   - a string        → use it verbatim as the stub source.
 *   - (outDir)=>string→ a factory (used by sdkStub, which needs outDir).
 * Falsy/omitted keys are skipped, so a suite only aliases what it actually stubs.
 */
export async function writeStubs(outDir, spec = {}) {
	const aliases = {};
	for (const [key, value] of Object.entries(spec)) {
		if (value == null || value === false) continue;
		const specifier = STUB_SPECIFIERS[key];
		if (!specifier) throw new Error(`writeStubs: unknown stub key: ${key}`);
		let source;
		if (value === true) {
			source = STUB_SOURCES[key];
			if (source == null) throw new Error(`writeStubs: no default stub source for: ${key}`);
		} else if (typeof value === "function") {
			source = value(outDir);
		} else {
			source = String(value);
		}
		const file = path.join(outDir, `stub-${key}.mjs`);
		await fs.writeFile(file, source);
		aliases[specifier] = file;
	}
	return aliases;
}

/**
 * Create a fresh tempdir and write the requested stubs into it, returning
 * { outDir, aliases }. Use this when a suite bundles MORE THAN ONE entry that must
 * share the same outDir/stubs (e.g. a consistent getAgentDir across two extensions);
 * then call bundle() once per entry with the shared `aliases`.
 */
export async function makeBuildDir(name, stubs = {}) {
	if (!name) throw new Error("makeBuildDir: { name } is required");
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	const aliases = await writeStubs(outDir, stubs);
	return { outDir, aliases };
}

/**
 * esbuild a single entry into <outDir>/<outName> with the given `--alias` map and
 * return the file:// URL. Throws with esbuild's stderr on failure. Passing an alias
 * for a module the entry never imports is harmless (esbuild simply ignores it).
 */
export async function bundle({ src, outDir, outName, aliases = {}, npx = "--no-install" }) {
	if (!src) throw new Error("bundle: { src } (absolute entry path) is required");
	if (!outDir) throw new Error("bundle: { outDir } is required");
	if (!outName) throw new Error("bundle: { outName } is required");
	if (!existsSync(src)) throw new Error(`bundle: missing source: ${src}`);
	const out = path.join(outDir, outName);
	const args = [npx, "esbuild", src, "--bundle", "--platform=node", "--format=esm"];
	for (const [specifier, file] of Object.entries(aliases)) args.push(`--alias:${specifier}=${file}`);
	args.push(`--outfile=${out}`);
	const r = spawnSync("npx", args, { cwd: REPO_ROOT, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`esbuild failed for ${outName}: ${r.stderr || r.stdout}`);
	return pathToFileURL(out).href;
}

/**
 * Bundle a single extension entry to a tempdir ESM file via esbuild and return
 * { outDir, url }. Self-bootstrapping: never imports a stale build. Convenience
 * wrapper around makeBuildDir + bundle for the common single-entry case.
 *
 * Options:
 *   - name:    tempdir prefix (e.g. "pi-bg-jobs-integration").
 *   - src:     absolute path to the entry (e.g. <repo>/extensions/pi-bg/index.ts).
 *   - outName: output filename inside the tempdir (e.g. "bg.mjs").
 *   - stubs:   spec passed to writeStubs (default {} = no aliases).
 *   - npx:     "--no-install" (default; esbuild is a pinned devDependency, so no network is
 *              needed and the run stays offline-deterministic) or "--yes" — preserved per suite.
 *   - copyDirs: { destName: absSrcDir } — sibling asset dirs copied into the tempdir next to the
 *               bundle, for entries that read files at runtime relative to import.meta.url
 *               (e.g. pi-dynamic-workflows reads scaffolds/*.js beside its module).
 */
export async function buildExtension({ name, src, outName, stubs = {}, npx = "--no-install", copyDirs = {} }) {
	const { outDir, aliases } = await makeBuildDir(name, stubs);
	for (const [dest, srcDir] of Object.entries(copyDirs)) {
		await fs.cp(srcDir, path.join(outDir, dest), { recursive: true });
	}
	const url = await bundle({ src, outDir, outName, aliases, npx });
	return { outDir, url };
}
