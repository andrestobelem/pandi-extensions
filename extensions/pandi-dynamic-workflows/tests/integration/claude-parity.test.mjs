/**
 * Test durable de paridad: los scaffolds .claude/workflows/*.js son artifacts GENERADOS,
 * producidos determinísticamente desde los scaffolds pi canónicos
 * (extensions/pandi-dynamic-workflows/scaffolds/*.js) por
 * .claude/scripts/generate-claude-workflows.mjs.
 *
 * Esto pinea:
 *   - En sync: `generate-claude-workflows.mjs --check` sale 0 (cada archivo Claude
 *     commiteado byte-equals el output del generador). Falla si alguien edita a mano un scaffold
 *     Claude, o edita un scaffold pi sin regenerar.
 *   - Shape: cada scaffold Claude es un script top-level: empieza con `export const
 *     meta`, tiene sintaxis válida de top-level-script, y NO contiene `export default`
 *     (la Workflow tool de Claude Code rechaza export-default-main; necesita scripts top-level).
 *   - Sensibilidad (negative control): un tweak de un carácter a un archivo generado se
 *     detecta como drift, así el check de paridad no es vacuo.
 *
 * Sin build de extensión / sin modelo: este es un test puro de filesystem + proceso generador.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/claude-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withIsolatedRepoCopy, withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");
const OUT_DIR = path.join(REPO_ROOT, ".claude", "workflows");
// Segundo destino generado (#26): el skill ultracode lleva su propia copia del catálogo
// Claude-side para que el skill siga autocontenido en instalaciones standalone; se genera
// desde los MISMOS scaffolds canónicos y debe permanecer byte-equal a OUT_DIR.
const SNAPSHOT_DIR = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "reference", "claude-workflows");

const { check, counts } = createChecker();

function runCheck(repoRoot = REPO_ROOT) {
	return spawnSync(
		process.execPath,
		[path.join(repoRoot, ".claude", "scripts", "generate-claude-workflows.mjs"), "--check"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
}

async function main() {
	// 1) Generado == commiteado para todos los scaffolds.
	const res = runCheck();
	check(
		"generate-claude-workflows.mjs --check is in sync (Claude files == generator output)",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ")}`,
	);

	// 2) Cada scaffold Claude tiene shape válido de top-level-script, uno por scaffold pi.
	const srcNames = fs
		.readdirSync(SRC_DIR)
		.filter((f) => f.endsWith(".js"))
		.sort();
	const outNames = fs
		.readdirSync(OUT_DIR)
		.filter((f) => f.endsWith(".js"))
		.sort();
	check(
		"every pi scaffold has a generated Claude counterpart (1:1)",
		srcNames.length > 0 && srcNames.join(",") === outNames.join(","),
		`pi=${srcNames.length} claude=${outNames.length}`,
	);

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-parity-"));
	for (const name of outNames) {
		const text = fs.readFileSync(path.join(OUT_DIR, name), "utf8");
		check(`${name}: starts with \`export const meta\``, /^export const meta\b/m.test(text.trimStart()));
		check(
			`${name}: contains no \`export default\` (Claude rejects export-default-main)`,
			!/\bexport default\b/.test(text),
		);
		// Sintaxis válida de top-level-script: envolvé el body en una función (refleja cómo ambos
		// runtimes los ejecutan) para que un `return`/`await` top-level sea legal, luego node --check.
		const wrapped = path.join(tmp, name.replace(/\.js$/, ".cjs"));
		fs.writeFileSync(wrapped, `(async function(){\n${text.replace(/^export const /m, "const ")}\n})();\n`);
		const chk = spawnSync(process.execPath, ["--check", wrapped], { encoding: "utf8" });
		check(
			`${name}: valid top-level-script syntax (wrapped node --check)`,
			chk.status === 0,
			(chk.stderr || "").trim().split("\n")[0],
		);
	}
	fs.rmSync(tmp, { recursive: true, force: true });

	// 3) Paridad de snapshot (#26): la copia reference del skill ultracode es el MISMO artifact
	//    generado — cada archivo de catálogo debe ser byte-equal en el snapshot dir.
	for (const name of outNames) {
		let snapText = null;
		try {
			snapText = fs.readFileSync(path.join(SNAPSHOT_DIR, name), "utf8");
		} catch {}
		const catText = fs.readFileSync(path.join(OUT_DIR, name), "utf8");
		check(
			`snapshot: reference/claude-workflows/${name} is byte-equal to .claude/workflows/${name}`,
			snapText === catText,
			snapText === null ? "missing in snapshot dir" : `snapshot=${snapText.length}B catalog=${catText.length}B`,
		);
	}

	// 4) Sensibilidad / negative control: un tweak de un carácter debe registrarse como drift.
	const sample = outNames[0];
	await withIsolatedRepoCopy(REPO_ROOT, async (copyRoot) => {
		const samplePath = path.join(copyRoot, ".claude", "workflows", sample);
		const original = fs.readFileSync(samplePath, "utf8");
		await withMutatedFile(samplePath, `${original}\nconst __drift_probe__ = 1;\n`, () => {
			const tweaked = runCheck(copyRoot);
			check(
				`negative control: a hand-edit to ${sample} is detected as drift (--check exits non-zero)`,
				tweaked.status !== 0,
				`exit=${tweaked.status}`,
			);
		});
		check(
			`negative control restored isolated ${sample} byte-for-byte`,
			fs.readFileSync(samplePath, "utf8") === original,
		);

		// 5) Negative control para el destino SNAPSHOT: --check también debe vigilarlo.
		const snapSamplePath = path.join(copyRoot, ".pi", "skills", "ultracode", "reference", "claude-workflows", sample);
		let snapOriginal = null;
		try {
			snapOriginal = fs.readFileSync(snapSamplePath, "utf8");
		} catch {}
		if (snapOriginal !== null) {
			await withMutatedFile(snapSamplePath, `${snapOriginal}\nconst __snapshot_drift_probe__ = 1;\n`, () => {
				const tweaked = runCheck(copyRoot);
				check(
					`negative control: a hand-edit to the SNAPSHOT copy of ${sample} is detected as drift`,
					tweaked.status !== 0,
					`exit=${tweaked.status}`,
				);
			});
			check(
				`negative control restored isolated snapshot ${sample} byte-for-byte`,
				fs.readFileSync(snapSamplePath, "utf8") === snapOriginal,
			);
		} else {
			check(`negative control: snapshot copy of ${sample} exists`, false, "missing in snapshot dir");
		}
	});

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
	process.exit(0);
}

await main();
