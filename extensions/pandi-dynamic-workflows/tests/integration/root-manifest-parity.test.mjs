/**
 * Test durable de paridad para el manifest raíz de pi: `pi.extensions` y `pi.themes`
 * del package.json raíz se DERIVAN desde cada manifest pi de
 * `extensions/pandi-<name>/package.json` vía `scripts/sync-root-manifest.mjs`
 * (fuente de verdad = los sub-paquetes). Agregar una extensión nunca debe requerir editar
 * a mano la lista raíz — y olvidar registrar una debe detectarse acá en vez de no cargarla
 * silenciosamente.
 *
 * Esto fija:
 *   - En sync: `sync-root-manifest.mjs --check` sale 0 (manifest raíz == derivación).
 *   - Cobertura: cada package extensions/pandi que declara pi.extensions aparece en
 *     root pi.extensions (e igual pi.themes), así nada se shipea sin registrar.
 *   - Sensibilidad (control negativo): dropear una entry raíz se detecta como drift
 *     (exit 1), así el check no es vacuo. El archivo raíz se restaura después.
 *
 * Sin build de extensión / sin modelo: test puro de filesystem + proceso de script.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/root-manifest-parity.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";
import { withIsolatedRepoCopy, withMutatedFile } from "../../../shared/test/negative-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-root-manifest.mjs");
const ROOT_PKG = path.join(REPO_ROOT, "package.json");

const { check, counts } = createChecker();

function runCheck(repoRoot = REPO_ROOT) {
	return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "sync-root-manifest.mjs"), "--check"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

async function main() {
	check("sync-root-manifest.mjs exists", fs.existsSync(SYNC));

	// 1) Manifest raíz en sync con la derivación desde sub-paquetes.
	const res = runCheck();
	check(
		"sync-root-manifest.mjs --check is in sync (root pi manifest == derivation)",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ")}`,
	);

	// 2) Cobertura: cada entry pi.extensions/pi.themes de sub-paquete está presente en raíz.
	const root = JSON.parse(fs.readFileSync(ROOT_PKG, "utf8"));
	const extensionsDir = path.join(REPO_ROOT, "extensions");
	const dirs = fs
		.readdirSync(extensionsDir)
		.filter(
			(d) => (d === "pandi" || d.startsWith("pandi-")) && fs.existsSync(path.join(extensionsDir, d, "package.json")),
		);
	check("extension packages discovered", dirs.length >= 20, `found ${dirs.length}`);
	for (const dir of dirs) {
		const pkg = JSON.parse(fs.readFileSync(path.join(extensionsDir, dir, "package.json"), "utf8"));
		for (const entry of pkg.pi?.extensions ?? []) {
			const rootEntry = `./extensions/${dir}/${entry.replace(/^\.\//, "")}`;
			check(
				`root pi.extensions registers ${dir}`,
				(root.pi?.extensions ?? []).includes(rootEntry),
				`missing ${rootEntry}`,
			);
		}
		for (const entry of pkg.pi?.themes ?? []) {
			const rootEntry = `./extensions/${dir}/${entry.replace(/^\.\//, "")}`;
			check(`root pi.themes registers ${dir}`, (root.pi?.themes ?? []).includes(rootEntry), `missing ${rootEntry}`);
		}
	}

	// 3) Sensibilidad: dropeá la última entry root pi.extensions en una copia aislada y confirmá
	// que --check la detecta sin tocar el package.json tracked del checkout real.
	const dropLastExtension = (orig) => {
		const mutated = JSON.parse(orig);
		mutated.pi.extensions = mutated.pi.extensions.slice(0, -1);
		return `${JSON.stringify(mutated, null, "\t")}\n`;
	};
	await withIsolatedRepoCopy(REPO_ROOT, async (copyRoot) => {
		const copyRootPkg = path.join(copyRoot, "package.json");
		await withMutatedFile(copyRootPkg, dropLastExtension, () => {
			const drifted = runCheck(copyRoot);
			check("a dropped root entry is detected as drift (exit 1)", drifted.status === 1, `exit=${drifted.status}`);
		});
		check("isolated root manifest restored to in-sync after the negative control", runCheck(copyRoot).status === 0);
	});

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
