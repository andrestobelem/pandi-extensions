/**
 * Test durable para el check de doble copia agregado a extensions/pandi-doctor/scripts/doctor.mjs.
 *
 * El setup dev carga esta suite desde el WORKING TREE (entries de path local en settings de proyecto
 * y/o globales). Instalar una SEGUNDA copia de la suite bajo otra identidad pi
 * (clone git:… o paquete npm:@pandi-coding-agent/…) no lo deduplica pi
 * (la identidad difiere), así cada extensión/comando/theme cargaría dos veces. doctor debe
 * mostrar esa mezcla como warning ANTES de que muerda.
 *
 * El agent dir global es inyectable vía PI_DOCTOR_AGENT_DIR — misma costura de estilo que
 * CLAUDE_GLOBAL_DIR para el check de sync — así este test corre contra tmp dirs descartables
 * y nunca toca el ~/.pi/agent real.
 *
 * Pinea:
 *   - Presencia: doctor siempre imprime una línea "instalación sin doble copia".
 *   - Clean: un settings global con solo paquetes local-path/otros reporta OK (✓).
 *   - Mix (negative control): agregar una copia git: de esta suite cambia la línea a ⚠
 *     (los settings de proyecto del repo ya cargan el working tree), así el check no es
 *     vacuo. Una copia npm:@pandi-coding-agent/… también lo cambia.
 *   - Non-fatal: el estado es OPCIONAL — un warning nunca contribuye a las fallas requeridas
 *     que disparan exit(1).
 *
 * Asertamos solo stdout (NO_COLOR), nunca el exit code de doctor, porque eso depende
 * de tools requeridas no relacionadas presentes en el host / CI.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/doctor-double-copy.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const DOCTOR = path.join(REPO_ROOT, "extensions", "pandi-doctor", "scripts", "doctor.mjs");
const LABEL = "instalación sin doble copia";

const { check, counts } = createChecker();

function runDoctor(agentDir) {
	return spawnSync(process.execPath, [DOCTOR], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, PI_DOCTOR_AGENT_DIR: agentDir, PI_DOCTOR_CONFIG_DIR: ".pi", NO_COLOR: "1" },
	});
}

function makeAgentDir(packages) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-agent-"));
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages }, null, 2));
	return dir;
}

function lineFor(stdout) {
	return stdout.split("\n").find((l) => l.includes(LABEL));
}

function main() {
	// 1) Clean: solo paquetes global-local/no relacionados -> línea OK presente.
	const clean = runDoctor(makeAgentDir(["npm:pi-codex-web-search"]));
	const cleanLine = lineFor(clean.stdout);
	check("doctor prints the double-copy line", Boolean(cleanLine), `stdout tail: ${clean.stdout.slice(-300)}`);
	check("clean settings report OK (✓)", Boolean(cleanLine?.includes("✓")), `line: ${cleanLine}`);

	// 2) Mix: una copia git: de esta suite junto a los settings de proyecto working-tree -> ⚠.
	const gitMix = runDoctor(makeAgentDir(["git:github.com/andrestobelem/pi-dynamic-workflows@v0.1.0"]));
	const gitLine = lineFor(gitMix.stdout);
	check("a git: copy of the suite flips to a warning (⚠)", Boolean(gitLine?.includes("⚠")), `line: ${gitLine}`);

	// 3) Mix vía scope npm: una copia npm:@pandi-coding-agent/… también cambia a ⚠.
	const npmMix = runDoctor(makeAgentDir([{ source: "npm:@pandi-coding-agent/pandi-loop" }]));
	const npmLine = lineFor(npmMix.stdout);
	check("an npm scoped copy of the suite flips to a warning (⚠)", Boolean(npmLine?.includes("⚠")), `line: ${npmLine}`);

	// 4) Non-fatal: el warning nunca aparece entre fallas requeridas (vive bajo Opcionales).
	const requiredBlock = gitMix.stdout.split("Opcionales:")[0];
	check(
		"double-copy warning is optional, not a required failure",
		!requiredBlock.includes(LABEL),
		`required block: ${requiredBlock.slice(-200)}`,
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
