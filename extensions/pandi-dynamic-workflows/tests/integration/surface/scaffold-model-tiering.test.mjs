/**
 * Test de contrato conductual: la DECISIÓN de tier (modelo barato vs fuerte + effort por nodo)
 * se toma correctamente donde se CREAN workflows, no solo donde corren (#25).
 *
 * Hallazgo: workflow-factory — la ruta que genera workflows NUEVOS — nunca decidía
 * tiers: el schema PLAN del planner no tenía campo budget por nodo, el contrato codegen
 * listaba `{ label, schema, phase, effort }` (omitiendo `model`) sin requisito de tiering,
 * y el reviewer chequeaba "cost" genérico sin item explícito de tier. Por eso, los workflows
 * generados heredaban silenciosamente el modelo de sesión en cada nodo (scouts a precios opus).
 *
 * Esto pinea:
 *  1. FACTORY PLAN: el schema PLAN requiere entradas `budget` de
 *     { role, model, effort, why }, y el prompt del planner lleva la misma política normativa
 *     de ladder que contract-gate (un único texto de política en el repo).
 *  2. FACTORY CODEGEN: la línea de contrato de llamada incluye `model`, y un requisito hard
 *     exige model+effort explícitos por nodo desde el budget del plan con la convención de override
 *     node(role)/input.models/input.efforts.
 *  3. FACTORY REVIEW: el checklist del reviewer tiene un item TIERING explícito (fan-out amplio
 *     en el tier deep / judge-synthesis en el tier cheap / nodos sin model+effort explícitos
 *     son hallazgos).
 *  4. CATALOG INVARIANT: en CADA scaffold, cada call-site que setea `model` en opciones de agente
 *     también setea `effort` cerca, y ambos vienen de la ladder conocida
 *     (haiku|sonnet|opus x low|medium|high|xhigh|max), pineando el tiering auditado del catálogo
 *     para que un nodo sin tier o invertido no pueda aterrizar silenciosamente.
 *
 * Libre de mutación: lee las fuentes de scaffolds y hace pattern-match.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-model-tiering.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");
const factorySrc = fs.readFileSync(path.join(SCAFFOLDS_DIR, "workflow-factory.js"), "utf8");
const gateSrc = fs.readFileSync(path.join(SCAFFOLDS_DIR, "contract-gate.js"), "utf8");

// Política normativa de ladder: los mismos anclajes deben aparecer donde sea que la decisión de tier
// se delegue a un modelo (resource-plan de contract-gate Y planner de factory).
const LADDER = "haiku < sonnet < opus";
const KEEP_CHEAP = "baratos";

// ---------------------------------------------------------------------------
// 1) FACTORY PLAN: campo budget + política de ladder en el prompt del planner.
// ---------------------------------------------------------------------------

// El schema PLAN (el array required que también lista promptContracts) incluye budget.
const planRequired = factorySrc.match(/required:\s*\[[^\]]*"promptContracts"[^\]]*\]/s)?.[0] ?? "";
check(
	'factory plan: PLAN schema requires "budget"',
	planRequired.includes('"budget"'),
	planRequired || "PLAN required array not found",
);
check(
	"factory plan: budget entries require role/model/effort/why",
	/required:\s*\[\s*"role",\s*"model",\s*"effort",\s*"why"\s*\]/.test(factorySrc),
	"no budget item schema with required [role, model, effort, why]",
);
check(
	`factory plan: planner prompt carries the ladder policy ("${LADDER}")`,
	factorySrc.includes(LADDER),
	"ladder sentence missing from workflow-factory",
);
check(
	`factory plan: planner prompt keeps mechanical roles cheap ("${KEEP_CHEAP}")`,
	factorySrc.includes("Mantené baratos") && factorySrc.includes("stakes premium"),
	"keep-cheap-even-at-premium sentence missing from workflow-factory",
);
check(
	"policy alignment: contract-gate carries the same ladder anchors",
	gateSrc.includes(LADDER) && gateSrc.includes("baratos") && gateSrc.includes("premium"),
	"contract-gate lost the normative ladder anchors",
);

// ---------------------------------------------------------------------------
// 2) FACTORY CODEGEN: el contrato de llamada incluye model; tiering es requisito hard.
// ---------------------------------------------------------------------------

check(
	"factory codegen: call contract includes model ({ label, model, effort, schema, phase })",
	factorySrc.includes("{ label, model, effort, schema, phase }"),
	"codegen call-contract line does not offer the model option",
);
check(
	"factory codegen: TIER EVERY NODE hard requirement present",
	factorySrc.includes("TIER EVERY NODE"),
	"codegen has no explicit per-node tiering requirement",
);
check(
	"factory codegen: the tiering requirement itself demands the input.models[role] override convention",
	// Anclado a la MISMA línea de bullet que TIER EVERY NODE, para que el comentario helper node()
	// propio de factory (que también menciona input.models[role]) no pueda satisfacerlo vacuamente.
	/TIER EVERY NODE[^\n]*input\.models\[role\]/.test(factorySrc),
	"codegen does not require the per-role override convention in the tiering bullet",
);

// ---------------------------------------------------------------------------
// 3) FACTORY REVIEW: item tier-check explícito en el checklist del reviewer.
// ---------------------------------------------------------------------------

check(
	"factory review: reviewer checklist has the TIERING item",
	factorySrc.includes("revisá TIERING"),
	"review prompt has no explicit tier-check item",
);

// ---------------------------------------------------------------------------
// 4) CATALOG INVARIANT: cada call-site de model está emparejado con un effort de ladder.
// ---------------------------------------------------------------------------

const MODELS = new Set(["haiku", "sonnet", "opus"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Solo matchean opciones model de string-literal (las definiciones de propiedades de schema usan `model: {`).
const MODEL_SITE = /model:\s*"([^"]+)"/g;
const EFFORT_SITE = /effort:\s*"([^"]+)"/;
const WINDOW_LINES = 5;

const scaffolds = fs
	.readdirSync(SCAFFOLDS_DIR)
	.filter((f) => f.endsWith(".js"))
	.sort();
check("catalog: scaffolds discovered", scaffolds.length >= 20, `found ${scaffolds.length}`);

for (const file of scaffolds) {
	const src = fs.readFileSync(path.join(SCAFFOLDS_DIR, file), "utf8");
	const lines = src.split("\n");
	const problems = [];
	for (let i = 0; i < lines.length; i++) {
		MODEL_SITE.lastIndex = 0;
		for (const m of lines[i].matchAll(MODEL_SITE)) {
			const model = m[1];
			if (!MODELS.has(model)) {
				problems.push(`${file}:${i + 1} model "${model}" is not on the ladder (haiku|sonnet|opus)`);
				continue;
			}
			// El effort emparejado debe estar en el mismo literal de opciones; el estilo de scaffold los mantiene
			// dentro de pocas líneas (misma línea o líneas adyacentes del literal de objeto).
			const lo = Math.max(0, i - WINDOW_LINES);
			const hi = Math.min(lines.length, i + WINDOW_LINES + 1);
			const windowText = lines.slice(lo, hi).join("\n");
			const effort = windowText.match(EFFORT_SITE)?.[1];
			if (!effort) {
				problems.push(`${file}:${i + 1} model "${model}" has no effort within ±${WINDOW_LINES} lines`);
			} else if (!EFFORTS.has(effort)) {
				problems.push(`${file}:${i + 1} effort "${effort}" is not on the ladder (low..max)`);
			}
		}
	}
	check(`catalog: ${file} pairs every model with a ladder effort`, problems.length === 0, problems.join("; "));
}

console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
if (counts.failed) {
	console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
	process.exit(1);
}
