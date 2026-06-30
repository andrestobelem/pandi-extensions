#!/usr/bin/env node
/**
 * Unit tests for the PURE/file helpers in extensions/pi-bg that the coverage audit flagged
 * as high-risk but untested:
 *   - storage.ts: validJobId (path-traversal guard), lstatPlainDirectory,
 *     lstatPlainDirectoryChain, ensurePlainDirectory (symlink/non-dir refusal).
 *   - runtime-state.ts: asString / asNumber (finite-number coercion).
 *
 * These guards exist to stop a malicious/buggy job id or a symlinked path from escaping the
 * bg runs directory, so they deserve direct coverage. Real filesystem fixtures (tmpdir) are
 * used for the lstat chain so symlink behavior is exercised, not mocked away.
 *
 * Run it:
 *   node extensions/pi-bg/tests/integration/bg-helpers.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioStorage(url) {
	const { validJobId, lstatPlainDirectory, lstatPlainDirectoryChain, ensurePlainDirectory } = await loadModule(url);

	// --- validJobId: the path-traversal / hidden-file guard ---
	const valid = ["bg-abc_1.2", "A", "abc123", "x.y-z_2", "bg-lq3k9-1a2b3c4d"];
	for (const id of valid) check(`validJobId accepts: ${JSON.stringify(id)}`, validJobId(id) === true);
	const invalid = ["", ".", "..", ".hidden", ".audit.jsonl", "../x", "a/b", "-leading", "a b", "a\\b", "..\\x"];
	for (const id of invalid) check(`validJobId rejects: ${JSON.stringify(id)}`, validJobId(id) === false);

	// --- filesystem fixtures for the lstat guards ---
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-storage-"));
	try {
		const realDir = path.join(tmp, "realdir");
		const nested = path.join(realDir, "a", "b");
		await fs.mkdir(nested, { recursive: true });
		const regularFile = path.join(tmp, "file.txt");
		await fs.writeFile(regularFile, "x");
		const symlinkToDir = path.join(tmp, "linkdir");
		let symlinkOk = true;
		try {
			await fs.symlink(realDir, symlinkToDir, "dir");
		} catch {
			symlinkOk = false; // some platforms/CI forbid symlink creation
		}
		const missing = path.join(tmp, "nope");

		check("lstatPlainDirectory true for a real dir", (await lstatPlainDirectory(realDir)) === true);
		check("lstatPlainDirectory false for a regular file", (await lstatPlainDirectory(regularFile)) === false);
		check("lstatPlainDirectory false for a missing path (ENOENT swallowed)", (await lstatPlainDirectory(missing)) === false);
		if (symlinkOk) {
			check("lstatPlainDirectory false for a symlink-to-dir", (await lstatPlainDirectory(symlinkToDir)) === false);
		} else {
			check("lstatPlainDirectory symlink case skipped (symlink unsupported here)", true);
		}

		// chain: true only when every component is a real, non-symlinked dir under base.
		check("lstatPlainDirectoryChain true for nested real dirs under base", (await lstatPlainDirectoryChain(realDir, nested)) === true);
		check("lstatPlainDirectoryChain false for a target outside base ('..')", (await lstatPlainDirectoryChain(realDir, path.join(tmp, "elsewhere"))) === false);
		check("lstatPlainDirectoryChain false for an absolute escape", (await lstatPlainDirectoryChain(realDir, "/")) === false);
		// base === target yields an empty relative, which the guard rejects (the chain is only
		// ever asked about a CHILD of base; same-dir is treated as out of scope → false).
		check("lstatPlainDirectoryChain false for base === target (empty relative rejected)", (await lstatPlainDirectoryChain(realDir, realDir)) === false);
		if (symlinkOk) {
			const throughLink = path.join(symlinkToDir, "a");
			check("lstatPlainDirectoryChain false when a component is symlinked", (await lstatPlainDirectoryChain(tmp, throughLink)) === false);
		} else {
			check("lstatPlainDirectoryChain symlink-component case skipped", true);
		}

		// ensurePlainDirectory: creates, tolerates EEXIST, refuses non-dir / symlink.
		const fresh = path.join(tmp, "fresh");
		await ensurePlainDirectory(fresh);
		check("ensurePlainDirectory creates a fresh dir", (await lstatPlainDirectory(fresh)) === true);
		let secondThrew = false;
		try {
			await ensurePlainDirectory(fresh); // EEXIST tolerated
		} catch {
			secondThrew = true;
		}
		check("ensurePlainDirectory tolerates EEXIST on second call", secondThrew === false);

		let fileThrew = false;
		try {
			await ensurePlainDirectory(regularFile); // exists but is a file
		} catch (e) {
			fileThrew = /Refusing to use non-directory or symlink/.test(String(e && e.message));
		}
		check("ensurePlainDirectory refuses an existing regular file", fileThrew === true);

		if (symlinkOk) {
			let linkThrew = false;
			try {
				await ensurePlainDirectory(symlinkToDir);
			} catch (e) {
				linkThrew = /Refusing to use non-directory or symlink/.test(String(e && e.message));
			}
			check("ensurePlainDirectory refuses a symlink-to-dir", linkThrew === true);
		} else {
			check("ensurePlainDirectory symlink-refusal case skipped", true);
		}
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

async function scenarioRuntimeState(url) {
	const { asNumber, asString } = await loadModule(url);

	check("asNumber returns finite numbers", asNumber(42) === 42 && asNumber(0) === 0 && asNumber(-3.5) === -3.5);
	check("asNumber rejects NaN/Infinity", asNumber(NaN) === undefined && asNumber(Infinity) === undefined && asNumber(-Infinity) === undefined);
	check("asNumber rejects non-numbers", asNumber("42") === undefined && asNumber(null) === undefined && asNumber(undefined) === undefined && asNumber({}) === undefined);

	check("asString returns strings", asString("hi") === "hi" && asString("") === "");
	check("asString rejects non-strings", asString(42) === undefined && asString(null) === undefined && asString(undefined) === undefined && asString({}) === undefined);
}

async function main() {
	const storage = await buildExtension({
		name: "pi-bg-storage-helpers",
		src: path.join(REPO_ROOT, "extensions", "pi-bg", "storage.ts"),
		outName: "storage.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
		npx: "--yes",
	});
	try {
		await scenarioStorage(storage.url);
	} finally {
		await fs.rm(storage.outDir, { recursive: true, force: true });
	}

	const runtimeState = await buildExtension({
		name: "pi-bg-runtime-state-helpers",
		src: path.join(REPO_ROOT, "extensions", "pi-bg", "runtime-state.ts"),
		outName: "runtime-state.mjs",
		npx: "--yes",
	});
	try {
		await scenarioRuntimeState(runtimeState.url);
	} finally {
		await fs.rm(runtimeState.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
