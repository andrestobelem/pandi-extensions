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
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/negative-control-guard.test.mjs
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
	spawnSync(
		"node",
		[
			"-e",
			`const { spawn } = require('node:child_process');
			 const c = spawn('node', [${JSON.stringify(childFile)}], { stdio: ['ignore','pipe','inherit'] });
			 c.stdout.on('data', (d) => { if (String(d).includes('MUTATED')) setTimeout(() => c.kill('SIGTERM'), 50); });
			 c.on('exit', () => process.exit(0));`,
		],
		{ encoding: "utf8", timeout: 20000 },
	);
	const afterKill = fs.readFileSync(marker, "utf8");
	check(
		"file restored after child SIGTERM'd mid-mutation (crash-safe guard)",
		afterKill === ORIGINAL,
		`after=${JSON.stringify(afterKill)}`,
	);

	fs.rmSync(dir, { recursive: true, force: true });

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
