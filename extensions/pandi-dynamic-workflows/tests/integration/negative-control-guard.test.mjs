/**
 * Test for the shared crash-safe negative-control helper `withMutatedFile`
 * (extensions/shared/test/negative-control.mjs).
 *
 * The parity/drift suites prove their --check is non-vacuous by temporarily overwriting a TRACKED
 * repo file, running the real check, then restoring it in a `finally`. The hazard (design-review R4,
 * confirmed systemic across 7 suites): if the process is SIGTERM'd/crashes BETWEEN the mutation and
 * the finally-restore (the runner hard-kills a suite at 120s), the tracked file is left dirty/half-
 * written. `withMutatedFile` keeps the in-place mutation but also registers a process-level restore
 * on SIGTERM/exit so a hard kill still restores the original.
 *
 * This pins:
 *   1. Behavior: fn sees the mutated content; after, the file is byte-restored.
 *   2. Throw-safety: if fn throws, the file is still restored (finally) and the throw propagates.
 *   3. Crash-safety (the point): a child process SIGTERM'd mid-mutation still restores the file,
 *      via the registered signal handler — proven with a real child, not a mock.
 *   4. Nested same-file mutation is rejected rather than losing the original restore baseline.
 *   5. Atomicity (issue #8): every replacement lands via rename (new inode on POSIX), never by
 *      truncating the live file — a concurrent reader (esbuild resolving the REAL root
 *      package.json while a parity suite mutates it) must never observe a truncated file.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/negative-control-guard.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HELPER = path.join(REPO_ROOT, "extensions", "shared", "test", "negative-control.mjs");

const { check, counts } = createChecker();

async function main() {
	check("negative-control.mjs exists", fs.existsSync(HELPER));
	const { withMutatedFile } = await import(HELPER);

	// 1) Behavior: fn sees mutated content; file restored afterwards.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "negctl-"));
	const f = path.join(dir, "tracked.txt");
	const ORIGINAL = "original-content\n";
	fs.writeFileSync(f, ORIGINAL);
	let seen = null;
	const ret = await withMutatedFile(
		f,
		(orig) => `${orig}MUTATED`,
		(orig) => {
			seen = fs.readFileSync(f, "utf8");
			return orig.length;
		},
	);
	check("fn observes the mutated content", seen === `${ORIGINAL}MUTATED`, `seen=${JSON.stringify(seen)}`);
	check("fn receives the original as its arg (return threaded)", ret === ORIGINAL.length, `ret=${ret}`);
	check("file is byte-restored after withMutatedFile", fs.readFileSync(f, "utf8") === ORIGINAL);

	// 2) Throw-safety: file restored even if fn throws, and the error propagates.
	let threw = false;
	try {
		await withMutatedFile(f, "TEMP", () => {
			throw new Error("boom");
		});
	} catch {
		threw = true;
	}
	check("throw from fn propagates", threw);
	check("file restored after fn throws", fs.readFileSync(f, "utf8") === ORIGINAL);

	// 3) Crash-safety: a child SIGTERM'd mid-mutation still restores the file via the signal guard.
	const marker = path.join(dir, "child-target.txt");
	fs.writeFileSync(marker, ORIGINAL);
	const childSrc = `
import { withMutatedFile } from ${JSON.stringify(HELPER)};
const f = ${JSON.stringify(marker)};
await withMutatedFile(f, "DIRTY-BY-CHILD", async () => {
  process.send?.("mutated");
  console.log("MUTATED");
  await new Promise((r) => setTimeout(r, 10000)); // hang so the parent can SIGTERM us mid-mutation
});
`;
	const childFile = path.join(dir, "child.mjs");
	fs.writeFileSync(childFile, childSrc);
	// Run the child, let it mutate, then SIGTERM it; the signal guard must restore before exit.
	const crash = spawnSync(
		process.execPath,
		[
			"-e",
			`const { spawn } = require('node:child_process');
			 const child = spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: ['ignore','pipe','inherit'] });
			 let observedMutation = false;
			 const timeout = setTimeout(() => {
			   console.error('timeout waiting for MUTATED marker');
			   child.kill('SIGKILL');
			   process.exit(2);
			 }, 5000);
			 child.stdout.on('data', (d) => {
			   const text = String(d);
			   process.stdout.write(text);
			   if (!observedMutation && text.includes('MUTATED')) {
			     observedMutation = true;
			     console.log('PARENT_OBSERVED_MUTATED');
			     setTimeout(() => {
			       const sent = child.kill('SIGTERM');
			       console.log('PARENT_SENT_SIGTERM=' + sent);
			     }, 50);
			   }
			 });
			 child.on('error', (error) => {
			   clearTimeout(timeout);
			   console.error(String(error && error.stack || error));
			   process.exit(3);
			 });
			 child.on('exit', (code, signal) => {
			   clearTimeout(timeout);
			   if (!observedMutation) {
			     console.error('child exited before MUTATED marker: code=' + code + ' signal=' + signal);
			     process.exit(4);
			   }
			   if (!(code === 143 || signal === 'SIGTERM')) {
			     console.error('child did not exit from SIGTERM handler: code=' + code + ' signal=' + signal);
			     process.exit(5);
			   }
			   console.log('PARENT_OBSERVED_SIGTERM_EXIT');
			   process.exit(0);
			 });`,
		],
		{ encoding: "utf8", timeout: 20000 },
	);
	const crashDetails = `status=${crash.status} signal=${crash.signal} stdout=${JSON.stringify(crash.stdout)} stderr=${JSON.stringify(crash.stderr)}`;
	check("crash harness wrapper exits cleanly", crash.status === 0, crashDetails);
	check(
		"crash harness observed the child mutation marker before killing it",
		crash.stdout.includes("PARENT_OBSERVED_MUTATED"),
		crashDetails,
	);
	check(
		"crash harness observed the child SIGTERM-handler exit",
		crash.stdout.includes("PARENT_OBSERVED_SIGTERM_EXIT"),
		crashDetails,
	);
	const afterKill = fs.readFileSync(marker, "utf8");
	check(
		"file restored after child SIGTERM'd mid-mutation (crash-safe guard)",
		afterKill === ORIGINAL,
		`after=${JSON.stringify(afterKill)}`,
	);

	// 4) Nested same-file mutation: reject instead of overwriting the restore baseline.
	let nestedRejected = false;
	await withMutatedFile(f, "OUTER", async () => {
		try {
			await withMutatedFile(f, "INNER", () => undefined);
		} catch (error) {
			nestedRejected = /already being mutated/.test(String(error?.message || error));
		}
		check("nested same-file mutation is rejected", nestedRejected);
		check("outer mutation remains active after nested rejection", fs.readFileSync(f, "utf8") === "OUTER");
	});
	check("file restored after rejected nested mutation", fs.readFileSync(f, "utf8") === ORIGINAL);

	// 5) Atomicity (issue #8): suites run in a parallel pool and esbuild (cwd = repo root)
	// resolves the REAL root package.json while the parity suites mutate it in place. In-place
	// fs.writeFileSync truncates before writing, so a parallel reader can observe an EMPTY file
	// (CI: "Unexpected end of file in JSON — package.json:1:0"). Pin the atomic mechanism
	// deterministically: each replacement must land via rename — a NEW inode on POSIX — never
	// by truncating the live inode.
	if (process.platform !== "win32") {
		const g = path.join(dir, "atomic-target.txt");
		fs.writeFileSync(g, ORIGINAL);
		const inoBefore = fs.statSync(g).ino;
		let inoDuring = null;
		await withMutatedFile(g, "ATOMIC-MUTATED", () => {
			inoDuring = fs.statSync(g).ino;
		});
		const inoAfter = fs.statSync(g).ino;
		check(
			"mutation lands via rename, not in-place truncate (new inode)",
			inoDuring !== null && inoDuring !== inoBefore,
			`before=${inoBefore} during=${inoDuring}`,
		);
		check(
			"restore lands via rename, not in-place truncate (new inode)",
			inoAfter !== inoDuring,
			`during=${inoDuring} after=${inoAfter}`,
		);
		check(
			"no temp sibling left behind next to the target",
			fs.readdirSync(dir).filter((n) => n.startsWith("atomic-target.txt.")).length === 0,
			fs.readdirSync(dir).join(","),
		);
		check("content byte-restored after atomic mutate+restore", fs.readFileSync(g, "utf8") === ORIGINAL);
	} else {
		check("atomicity pin skipped on win32 (inode semantics)", true);
	}

	fs.rmSync(dir, { recursive: true, force: true });

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
