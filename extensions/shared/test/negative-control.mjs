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

// path -> original content still owed a restore. A Map so nested/parallel mutations each restore.
const pending = new Map();
let guardsInstalled = false;

function restoreAll() {
	for (const [file, original] of pending) {
		try {
			fs.writeFileSync(file, original);
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
	const original = fs.readFileSync(filePath, "utf8");
	installGuards();
	pending.set(filePath, original);
	try {
		const next = typeof mutate === "function" ? mutate(original) : mutate;
		fs.writeFileSync(filePath, next);
		return await fn(original);
	} finally {
		fs.writeFileSync(filePath, original);
		pending.delete(filePath);
	}
}
