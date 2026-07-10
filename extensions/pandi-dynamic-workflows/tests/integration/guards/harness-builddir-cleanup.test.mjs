/**
 * Test de que el harness compartido auto-limpia sus tempdirs `makeBuildDir` al process exit.
 *
 * `buildExtension`/`makeBuildDir` crean un dir `mkdtemp` fresco por call (harness.mjs), pero cleanup
 * antes era opt-in por suite — solo ~3 de ~90 call sites de pandi-dynamic-workflows borraban su outDir,
 * así que el resto filtraba output de esbuild + assets copiados en el temp dir del SO en cada run
 * (hallazgo test-review P6 / D2#4). El harness ahora registra cada build dir para removerlo al exit.
 *
 * Esto pinea el comportamiento con un child process real:
 *   - el dir EXISTE mientras el proceso está vivo (cleanup es at-exit, no eager), y
 *   - el dir DESAPARECE después de que el proceso sale normalmente.
 *
 * Corrida:
 *   node extensions/pandi-dynamic-workflows/tests/integration/guards/harness-builddir-cleanup.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const HARNESS = path.join(REPO_ROOT, "extensions", "shared", "test", "harness.mjs");

const { check, counts } = createChecker();

function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "builddir-cleanup-test-"));
	const childFile = path.join(dir, "child.mjs");
	// El child crea un build dir, aserta que existe mientras vive, lo imprime y luego sale normalmente.
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
