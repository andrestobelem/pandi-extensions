/**
 * Crash-safe negative-control helper for the parity/drift suites.
 *
 * Those suites prove their `--check` is non-vacuous by temporarily overwriting a file, running the
 * real check, then restoring it. For tracked repo files, prefer `withIsolatedRepoCopy()`: it copies
 * the tracked tree to `.pi/tmp/…` so the negative control can mutate a disposable checkout-shaped
 * directory instead of the real worktree. `withMutatedFile()` remains the low-level crash-safe
 * mutation primitive for files inside that disposable tree or other temp fixtures.
 *
 * Test-harness code only (not shipped); shared across suites per the repo's "extensions/shared/ is
 * TEST code" rule. Import from a suite as:
 *   import { withMutatedFile } from "../../../shared/test/negative-control.mjs";
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Replace `file` in ONE atomic step: write a temp sibling, then rename(2) over the target.
// Suites run in a parallel pool and mutate REAL tracked files that sibling suites read
// concurrently (issue #8: esbuild, cwd = repo root, resolved the root package.json mid-
// truncate → "Unexpected end of file in JSON"). In-place writeFileSync opens with O_TRUNC,
// so a parallel reader can see an empty file; rename is atomic on POSIX, so readers always
// see either the old or the new content. Same-dir temp keeps the rename on one filesystem.
function atomicWriteFileSync(file, content) {
	const tmp = `${file}.negctl-${process.pid}.tmp`;
	fs.writeFileSync(tmp, content);
	try {
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best-effort temp cleanup; the rename error is the one worth surfacing.
		}
		throw err;
	}
}

// path -> original content still owed a restore. Same-file overlap is rejected so a nested
// mutation cannot overwrite the original restore baseline in this process.
const pending = new Map();
let guardsInstalled = false;

function restoreAll() {
	for (const [file, original] of pending) {
		try {
			atomicWriteFileSync(file, original);
		} catch {
			// best-effort on the way out; nothing useful to do if this fails during shutdown.
		}
	}
	pending.clear();
}

function installGuards() {
	if (guardsInstalled) return;
	guardsInstalled = true;
	// On a hard kill (runner SIGTERM at timeout) restore, then re-exit with the conventional code.
	process.once("SIGTERM", () => {
		restoreAll();
		process.exit(143);
	});
	process.once("SIGINT", () => {
		restoreAll();
		process.exit(130);
	});
	// Normal/unexpected exit: last-chance synchronous restore.
	process.once("exit", restoreAll);
}

function listTrackedFiles(repoRoot) {
	const res = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
	if (res.status !== 0) {
		throw new Error(`withIsolatedRepoCopy: git ls-files failed (${res.status}): ${res.stderr || res.stdout}`);
	}
	return res.stdout.split("\0").filter(Boolean);
}

function copyTrackedPath(repoRoot, copyRoot, relativePath) {
	const from = path.join(repoRoot, relativePath);
	const to = path.join(copyRoot, relativePath);
	const stat = fs.lstatSync(from);
	fs.mkdirSync(path.dirname(to), { recursive: true });
	if (stat.isSymbolicLink()) {
		fs.symlinkSync(fs.readlinkSync(from), to);
		return;
	}
	if (stat.isDirectory()) {
		fs.mkdirSync(to, { recursive: true });
		return;
	}
	fs.copyFileSync(from, to);
	fs.chmodSync(to, stat.mode);
}

/**
 * Copy the tracked repo tree to a disposable repo-shaped directory, run `fn(copyRoot)`, then delete it.
 *
 * The copy lives under the real repo's `.pi/tmp/` so spawned scripts inside the copy can still resolve
 * dev dependencies from the parent repo's `node_modules` via Node's normal upward lookup, while all
 * negative-control writes land in the disposable tree.
 *
 * @param {string} repoRoot
 * @param {(copyRoot: string) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withIsolatedRepoCopy(repoRoot, fn) {
	const root = path.resolve(repoRoot);
	const scratch = path.join(root, ".pi", "tmp");
	fs.mkdirSync(scratch, { recursive: true });
	const copyRoot = fs.mkdtempSync(path.join(scratch, "negative-control-repo-"));
	try {
		for (const relativePath of listTrackedFiles(root)) {
			copyTrackedPath(root, copyRoot, relativePath);
		}
		return await fn(copyRoot);
	} finally {
		fs.rmSync(copyRoot, { recursive: true, force: true });
	}
}

/**
 * Temporarily replace `filePath`'s content, run `fn(originalContent)`, then restore — crash-safe.
 *
 * @param {string} filePath              tracked file to mutate.
 * @param {string | ((orig: string) => string)} mutate  new content, or a fn of the original.
 * @param {(orig: string) => T | Promise<T>} fn  runs while the file holds the mutated content.
 * @returns {Promise<T>} whatever `fn` returns.
 */
export async function withMutatedFile(filePath, mutate, fn) {
	installGuards();
	if (pending.has(filePath)) {
		throw new Error(`withMutatedFile: ${filePath} is already being mutated`);
	}
	const original = fs.readFileSync(filePath, "utf8");
	pending.set(filePath, original);
	try {
		const next = typeof mutate === "function" ? mutate(original) : mutate;
		atomicWriteFileSync(filePath, next);
		return await fn(original);
	} finally {
		atomicWriteFileSync(filePath, original);
		pending.delete(filePath);
	}
}
