#!/usr/bin/env node
/**
 * Characterization coverage for extensions/pi-bg/process-liveness.ts.
 *
 * Fills the gaps the existing bg-jobs.test.mjs leaves in the pure liveness/identity
 * helpers: the error-code branches of probeProcessAlive, the platform branches of
 * readProcessStartId (Linux /proc parsing, darwin/BSD `ps` parsing, error-swallowing),
 * and verifyProcessIdentity's win32 degradation.
 *
 * These helpers read the OS via the GLOBAL `process` (process.kill / process.platform)
 * and via the MODULE imports `readFileSync` (node:fs) and `spawnSync`
 * (node:child_process). We bundle the module once with node:fs / node:child_process
 * aliased to injectable stubs (driven by globals), so we can feed deterministic
 * fixtures for the platform branches without any real subprocess or real /proc access,
 * and we temporarily override process.platform / process.kill (restored in finally) to
 * exercise each branch on this host. The source is the source of truth.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// Bundle process-liveness.ts with its two node builtins aliased to stubs that delegate
// to globals, so each test can inject the exact readFileSync/spawnSync behavior it needs.
async function buildLiveness() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-liveness-cov-"));
	const fsStub = path.join(outDir, "stub-fs.mjs");
	const cpStub = path.join(outDir, "stub-cp.mjs");
	await fs.writeFile(
		fsStub,
		"export function readFileSync(...args) {\n" +
			'\tif (typeof globalThis.__bgReadFileSync === "function") return globalThis.__bgReadFileSync(...args);\n' +
			'\tthrow new Error("readFileSync not stubbed in this test");\n' +
			"}\n",
	);
	await fs.writeFile(
		cpStub,
		"export function spawnSync(...args) {\n" +
			'\tif (typeof globalThis.__bgSpawnSync === "function") return globalThis.__bgSpawnSync(...args);\n' +
			'\tthrow new Error("spawnSync not stubbed in this test");\n' +
			"}\n",
	);
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pi-bg", "process-liveness.ts"),
		outDir,
		outName: "process-liveness.mjs",
		aliases: { "node:fs": fsStub, "node:child_process": cpStub },
		npx: "--no-install",
	});
	return url;
}

// Run `fn` with process.platform forced, then restore the original descriptor.
function withPlatform(value, fn) {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", original);
	}
}

// Run `fn` with process.kill replaced, then restore.
function withKill(impl, fn) {
	const original = process.kill;
	process.kill = impl;
	try {
		return fn();
	} finally {
		process.kill = original;
	}
}

function clearStubs() {
	globalThis.__bgReadFileSync = undefined;
	globalThis.__bgSpawnSync = undefined;
}

// --- probeProcessAlive error-code branches -------------------------------------------

function probeMapsErrorCodes(mod) {
	const probe = mod.probeProcessAlive;
	check("probe: probeProcessAlive is exported", typeof probe === "function", typeof probe);
	if (typeof probe !== "function") return;

	// EPERM = the process exists but is owned by another user -> still "alive".
	const eperm = withKill(
		() => {
			const err = new Error("operation not permitted");
			err.code = "EPERM";
			throw err;
		},
		() => probe(424242),
	);
	check("probe: EPERM maps to alive (foreign-owned but live)", eperm === "alive", String(eperm));

	// An unexpected/unrelated code -> best-effort "unknown" (never claim dead).
	const einval = withKill(
		() => {
			const err = new Error("invalid argument");
			err.code = "EINVAL";
			throw err;
		},
		() => probe(424242),
	);
	check("probe: unexpected code (EINVAL) maps to unknown", einval === "unknown", String(einval));

	// ESRCH = no such process -> "dead" (re-confirm the documented mapping alongside EPERM).
	const esrch = withKill(
		() => {
			const err = new Error("no such process");
			err.code = "ESRCH";
			throw err;
		},
		() => probe(424242),
	);
	check("probe: ESRCH maps to dead", esrch === "dead", String(esrch));

	// An error with NO code at all also falls through to unknown.
	const noCode = withKill(
		() => {
			throw new Error("mysterious");
		},
		() => probe(424242),
	);
	check("probe: error without a code maps to unknown", noCode === "unknown", String(noCode));
}

// --- readProcessStartId platform branches --------------------------------------------

function readStartIdLinuxBranch(mod) {
	const read = mod.readProcessStartId;
	if (typeof read !== "function") return;

	// A realistic /proc/<pid>/stat where comm contains spaces AND inner parens, so the
	// parser must slice after the LAST ')'. After-comm tokens are field 3 onward, so the
	// starttime (field 22, 1-indexed) lands at index 19 of those tokens.
	const tokens = Array.from({ length: 22 }, (_, i) => (i === 19 ? "987654" : String(i)));
	const statLine = `1234 (weird )name) ${tokens.join(" ")}\n`;
	globalThis.__bgReadFileSync = (file) => {
		check("startid-linux: reads the pid's /proc stat file", file === "/proc/4321/stat", String(file));
		return statLine;
	};
	const result = withPlatform("linux", () => read(4321));
	clearStubs();
	check("startid-linux: parses starttime after last ')' as lin:<starttime>", result === "lin:987654", String(result));

	// A stat line with too few post-comm tokens (no index 19) -> undefined.
	globalThis.__bgReadFileSync = () => "1234 (comm) 3 4 5\n";
	const shortResult = withPlatform("linux", () => read(4321));
	clearStubs();
	check("startid-linux: missing starttime token yields undefined", shortResult === undefined, String(shortResult));
}

function readStartIdDarwinBranch(mod) {
	const read = mod.readProcessStartId;
	if (typeof read !== "function") return;

	// status 0 with lstart output -> ps:<trimmed output>.
	globalThis.__bgSpawnSync = (cmd, args) => {
		check("startid-darwin: shells out to ps -o lstart=", cmd === "ps" && args.includes("lstart="), `${cmd} ${args}`);
		return { status: 0, stdout: "Mon Jun 30 12:00:00 2024\n" };
	};
	const ok = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid-darwin: status 0 yields ps:<lstart>", ok === "ps:Mon Jun 30 12:00:00 2024", String(ok));

	// Non-zero status -> the output is treated as empty -> undefined.
	globalThis.__bgSpawnSync = () => ({ status: 1, stdout: "Mon Jun 30 12:00:00 2024\n" });
	const failed = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid-darwin: non-zero status yields undefined", failed === undefined, String(failed));

	// status 0 but empty stdout -> undefined.
	globalThis.__bgSpawnSync = () => ({ status: 0, stdout: "   \n" });
	const empty = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid-darwin: empty stdout yields undefined", empty === undefined, String(empty));

	// The same branch is reached for *bsd platforms (platform.endsWith("bsd")).
	globalThis.__bgSpawnSync = () => ({ status: 0, stdout: "Tue Jul 1 09:00:00 2024\n" });
	const bsd = withPlatform("freebsd", () => read(4321));
	clearStubs();
	check("startid-bsd: *bsd reaches the ps branch", bsd === "ps:Tue Jul 1 09:00:00 2024", String(bsd));
}

function readStartIdSwallowsErrors(mod) {
	const read = mod.readProcessStartId;
	if (typeof read !== "function") return;

	// Linux: readFileSync throws (e.g. ENOENT) -> caught -> undefined.
	globalThis.__bgReadFileSync = () => {
		const err = new Error("no such file");
		err.code = "ENOENT";
		throw err;
	};
	const linThrow = withPlatform("linux", () => read(4321));
	clearStubs();
	check("startid: a throwing readFileSync is swallowed to undefined", linThrow === undefined, String(linThrow));

	// darwin: spawnSync throws -> caught -> undefined.
	globalThis.__bgSpawnSync = () => {
		throw new Error("spawn blew up");
	};
	const darwinThrow = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid: a throwing spawnSync is swallowed to undefined", darwinThrow === undefined, String(darwinThrow));
}

function readStartIdWin32Branch(mod) {
	const read = mod.readProcessStartId;
	if (typeof read !== "function") return;
	// win32 hits neither branch -> undefined (graceful degradation), with no stub calls.
	const result = withPlatform("win32", () => read(4321));
	check("startid-win32: unsupported platform yields undefined", result === undefined, String(result));
}

// --- verifyProcessIdentity win32 degradation -----------------------------------------

function verifyWin32Degrades(mod) {
	const verify = mod.verifyProcessIdentity;
	check("verify: verifyProcessIdentity is exported", typeof verify === "function", typeof verify);
	if (typeof verify !== "function") return;
	// On win32, readProcessStartId(pid) is undefined, so even WITH a recorded id the
	// current id is unreadable -> "unknown" (never claims same/different).
	const result = withPlatform("win32", () => verify(4321, "ps:anything"));
	check("verify-win32: degrades to unknown when current id is unreadable", result === "unknown", String(result));
}

async function main() {
	const url = await buildLiveness();
	const mod = await loadModule(url);
	clearStubs();
	probeMapsErrorCodes(mod);
	readStartIdLinuxBranch(mod);
	readStartIdDarwinBranch(mod);
	readStartIdSwallowsErrors(mod);
	readStartIdWin32Branch(mod);
	verifyWin32Degrades(mod);
	clearStubs();

	console.log(`${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
