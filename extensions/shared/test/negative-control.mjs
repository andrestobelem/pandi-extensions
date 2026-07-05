/**
 * Crash-safe negative-control helper for the parity/drift suites.
 *
 * Those suites prove their `--check` is non-vacuous by temporarily overwriting a TRACKED repo file,
 * running the real check, then restoring it. Doing the write in place is REQUIRED — the real check
 * scripts inspect the actual repo tree, not a copy — but a bare `try/finally` leaves the tracked
 * file dirty/half-written if the process is SIGTERM'd or crashes between the mutation and the
 * restore (the test runner hard-kills a suite at its 120s timeout). This helper keeps the in-place
 * mutation but ALSO registers a process-level restore on SIGTERM/SIGINT/exit, so even a hard kill
 * restores the original before the process dies.
 *
 * Test-harness code only (not shipped); shared across suites per the repo's "extensions/shared/ is
 * TEST code" rule. Import from a suite as:
 *   import { withMutatedFile } from "../../../shared/test/negative-control.mjs";
 */

import * as fs from "node:fs";

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
