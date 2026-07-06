/**
 * Guard: los scaffolds NO llevan nombres de modelo hardcodeados en call-sites.
 *
 * Por qué existe este archivo
 * ---------------------------
 * La guía model×effort (bullet L1 del system-prompt + skill ultracode L2) trata
 * model y effort como dos diales independientes que el AGENTE AUTOR decide por tarea.
 * Los scaffolds son la capa de recomendación-por-ejemplo: si sus call-sites hardcodean
 * `model: "haiku"`, los agentes pattern-matchean el pairing literal en vez de decidir.
 *
 * Política (spec de diseño, run 2026-07-05T11-51-48-660Z-model-effort-guidance):
 *   - Cada scaffold que spawnea agentes con tiers declara UNA tabla canónica:
 *       const TIERS = { cheap: "haiku", balanced: "sonnet", deep: "opus" };
 *     con un comentario que le pide al agente autor redecidir tiers por tarea.
 *   - Los call-sites usan el `tier: "cheap"|"balanced"|"deep"` simbólico (resuelto por
 *     el helper node() del scaffold vía TIERS), nunca un nombre de modelo.
 *   - `effort` sigue explícito en cada call-site (un dial separado; omitirlo heredaría
 *     el reasoning level raw de la sesión, ya que los scaffolds no setean agentType).
 *
 * Checks por extensions/pandi-dynamic-workflows/scaffolds/*.js:
 *   1. Fuera de la línea TIERS canónica, no aparece `model: "haiku|sonnet|opus"` ni
 *      ningún literal `model: "<provider>/…"` provider-qualified.
 *   2. Todo archivo que usa `tier:` o `TIERS` contiene exactamente la línea TIERS canónica
 *      (byte-idéntica, para que mirrors y docs puedan citar una sola forma).
 *   3. Cada `tier: "<value>"` es uno de cheap|balanced|deep: un typo falla ACÁ,
 *      estáticamente, en vez de heredar silenciosamente el modelo del orquestador en runtime
 *      (`log("unknown tier …")` de node() es la red de último recurso, no la única).
 *   4. Los nodos gate de large-migration.js que juzgan el output de `verifyCmd`
 *      PROVISTO POR EL CALLER (baseline / recheck / final-verify) default a effort >= medium:
 *      interpretar output arbitrario de comandos, posiblemente flaky, para decidir {green} es
 *      juicio, no transcripción; la tabla de piso L2 fija medium como default para gates
 *      user-verifyCmd (override por run vía input.efforts.*). bug-verify.js
 *      tree-baseline/tree-check quedan en `low` a propósito: transcriben literalmente
 *      `git status --porcelain`, cero juicio.
 *   5. Los nodos worker de orchestrator-workers.js default a effort high porque el
 *      integrator solo mergea/preserva evidencia y gaps; no vuelve a correr un paso
 *      de verificación explícito. Los callers pueden pasar tools mutantes vía input.tools
 *      / toolsByRole.worker, así que este es un default worker-without-guaranteed-net.
 *
 * Los 5 mirrors generados (.claude/workflows, .pi/skills/ultracode/reference/…,
 * extensions/…/skills/…, .claude/skills/…) quedan cubiertos transitivamente por los
 * checks de paridad format:claude / vendor / ultracode.
 *
 * Corrida directa:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-model-literals.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLDS_DIR = path.resolve(__dirname, "..", "..", "scaffolds");

const CANONICAL_TIERS = `const TIERS = { cheap: "haiku", balanced: "sonnet", deep: "opus" };`;
const VALID_TIERS = new Set(["cheap", "balanced", "deep"]);
const MODEL_NAME_LITERAL = /model:\s*["'](haiku|sonnet|opus)["']/g;
const MODEL_PROVIDER_LITERAL = /model:\s*["'][\w.-]+\//g;
const TIER_VALUE = /tier:\s*["']([\w-]+)["']/g;

let failures = 0;
function check(name, ok, detail = "") {
	if (ok) {
		console.log(`PASS: ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL: ${name}${detail ? `  [${detail}]` : ""}`);
	}
}

async function main() {
	const files = (await fs.readdir(SCAFFOLDS_DIR)).filter((f) => f.endsWith(".js")).sort();
	check("scaffolds directory has files", files.length > 0, SCAFFOLDS_DIR);

	for (const file of files) {
		const source = await fs.readFile(path.join(SCAFFOLDS_DIR, file), "utf8");
		const withoutTiersLine = source
			.split("\n")
			.filter((line) => !line.includes(CANONICAL_TIERS))
			.join("\n");

		const nameHits = [...withoutTiersLine.matchAll(MODEL_NAME_LITERAL)].map((m) => m[0]);
		check(`${file}: no bare model-name literals outside TIERS`, nameHits.length === 0, nameHits.join(", "));

		const providerHits = [...withoutTiersLine.matchAll(MODEL_PROVIDER_LITERAL)].map((m) => m[0]);
		check(`${file}: no provider-qualified model literals`, providerHits.length === 0, providerHits.join(", "));

		const usesTiers = /\bTIERS\b|tier:\s*["']/.test(withoutTiersLine);
		if (usesTiers) {
			check(`${file}: canonical TIERS line present`, source.includes(CANONICAL_TIERS));
		}

		const badTiers = [...source.matchAll(TIER_VALUE)].map((m) => m[1]).filter((v) => !VALID_TIERS.has(v));
		check(`${file}: all tier values are cheap|balanced|deep`, badTiers.length === 0, badTiers.join(", "));

		if (file === "large-migration.js") {
			for (const role of ["baseline", "recheck", "final-verify"]) {
				const call = new RegExp(`node\\("${role}",[^)]*effort:\\s*"low"`).exec(source);
				check(`${file}: user-verifyCmd gate "${role}" does not default to effort "low"`, call === null, call?.[0]);
			}
		}

		if (file === "orchestrator-workers.js") {
			const mediumWorker = /node\("worker",[^)]*effort:\s*"medium"/.exec(source);
			check(
				`${file}: worker default reflects no guaranteed downstream verification (effort high, not medium)`,
				mediumWorker === null,
				mediumWorker?.[0],
			);
		}
	}

	console.log(`\nTOTAL: ${failures === 0 ? "all passed" : `${failures} failed`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
