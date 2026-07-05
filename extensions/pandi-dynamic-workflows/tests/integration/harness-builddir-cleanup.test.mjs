/**
 * Test that the shared harness auto-cleans its `makeBuildDir` tempdirs at process exit.
 *
 * `buildExtension`/`makeBuildDir` create a fresh `mkdtemp` dir per call (harness.mjs), but cleanup
 * used to be opt-in per suite — only ~3 of ~90 pandi-dynamic-workflows call sites deleted their outDir,
 * so the rest leaked esbuild output + copied assets into the OS temp dir on every run (test-review
 * finding P6 / D2#4). The harness now registers each build dir for removal on process exit.
 *
 * This pins the behavior with a real child process:
 *   - the dir EXISTS while the process is alive (cleanup is at-exit, not eager), and
 *   - the dir is GONE after the process exits normally.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/harness-builddir-cleanup.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HARNESS = path.join(REPO_ROOT, "extensions", "shared", "test", "harness.mjs");

const { check, counts } = createChecker();

function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "builddir-cleanup-test-"));
	const childFile = path.join(dir, "child.mjs");
	// Child makes a build dir, asserts it exists while alive, prints it, then exits normally.
	fs.writeFileSync(
		childFile,
		`import { existsSync } from "node:fs";
import { makeBuildDir } from ${JSON.stringify(HARNESS)};
const { outDir } = await makeBuildDir("cleanup-probe");
console.log("EXISTS_DURING:" + existsSync(outDir));
console.log("DIR:" + outDir);
`,
	);
	const res = spawnSync(process.execPath, [childFile], { encoding: "utf8", timeout: 20000 });
	const out = `${res.stdout || ""}`;
	const existedDuring = /EXISTS_DURING:true/.test(out);
	const m = out.match(/DIR:(.+)/);
	const outDir = m ? m[1].trim() : null;

	check("child reported a build dir", !!outDir, `stdout=${out.trim()}`);
	check("build dir existed while the process was alive", existedDuring);
	if (outDir) {
		check("build dir is removed after the process exits (no leak)", !fs.existsSync(outDir), `dir=${outDir}`);
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
