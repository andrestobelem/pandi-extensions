#!/usr/bin/env node
/**
 * Regresión (#28): los nodos de agente codegen/refine de workflow-factory corrían con el silencioso
 * DEFAULT_AGENT_TIMEOUT_MS (10min/600000ms — config.ts:19), aunque generan
 * 15-25KB de código en sonnet/medium. Al timeoutear, la llamada agent() devuelve null, y
 * `extractJs(null)` se degrada silenciosamente a un STRING VACÍO que luego fluía directo
 * a la fase Review, enterrando el timeout real bajo un turno opus de review desperdiciado
 * ("the workflow code block is completely empty").
 *
 * Esto pinea tres cosas, puramente leyendo la fuente canónica del scaffold (sin llamadas a modelo,
 * sin mutación):
 *
 *   1. node("workflow-codegen", …) lleva un `timeoutMs` explícito muy por encima del
 *      default de 10 min (>= 20*60000 = 1,200,000ms).
 *   2. node("workflow-refine", …) también lleva un `timeoutMs` explícito por encima del
 *      default.
 *   3. Un guard fail-fast — un `throw` cuyo mensaje cita la evidencia de timeout/empty —
 *      queda DESPUÉS de `let code = extractJs(implement)` pero ANTES de `phase("Review")` /
 *      la llamada al agente reviewer, verificado por orden de índices de string. Así, un resultado
 *      codegen null o solo-whitespace nunca puede llegar al prompt de review.
 *
 * Libre de mutación: lee extensions/pandi-dynamic-workflows/scaffolds/workflow-factory.js
 * y hace pattern-match; no ejecuta el workflow ni llama ningún agente.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-codegen-guard.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");
const FACTORY_PATH = path.join(SCAFFOLDS_DIR, "workflow-factory.js");
const src = fs.readFileSync(FACTORY_PATH, "utf8");

// Timeout mínimo aceptable por agente para los roles codegen/refine: bastante por encima del
// DEFAULT_AGENT_TIMEOUT_MS de 600000ms (10min), según la guía "20-30min" del issue.
const MIN_TIMEOUT_MS = 20 * 60_000; // 1_200_000

/** Evalúa una expresión timeoutMs de literal numérico o multiplicación simple, p. ej.
 * "1_200_000" o "20 * 60_000". Devuelve null cuando no reconoce la expresión
 * (nunca hace throw: un valor no parseable debe aparecer como check fallido, no como crash). */
function evalTimeoutExpr(raw) {
	if (raw == null) return null;
	const cleaned = String(raw).replace(/_/g, "").trim();
	if (/^\d+$/.test(cleaned)) return Number(cleaned);
	const m = /^(\d+)\s*\*\s*(\d+)$/.exec(cleaned);
	if (m) return Number(m[1]) * Number(m[2]);
	return null;
}

/** Encontrá `node("<role>", { ...options... })` y devolvé el texto del literal de opciones, o
 * null si no se encuentra el call site. Los objetos de opciones en este scaffold son planos
 * (sin braces anidadas), así que alcanza con un match no-greedy hasta el primer `}`. */
function findNodeOptions(role) {
	const re = new RegExp(`node\\(\\s*"${role}"\\s*,\\s*(\\{[\\s\\S]*?\\})\\s*\\)`);
	const m = re.exec(src);
	return m ? m[1] : null;
}

function checkExplicitTimeout(role) {
	const optionsText = findNodeOptions(role);
	check(`node("${role}", …) call site found`, optionsText !== null, "call site not found in workflow-factory.js");
	const timeoutRaw = optionsText ? /timeoutMs:\s*([^,}]+)/.exec(optionsText)?.[1] : null;
	check(
		`node("${role}", …) sets an explicit timeoutMs`,
		timeoutRaw != null,
		optionsText ? `options: ${optionsText}` : "no options literal found",
	);
	const timeoutValue = evalTimeoutExpr(timeoutRaw);
	check(
		`node("${role}", …) timeoutMs (${timeoutRaw ?? "n/a"} = ${timeoutValue ?? "n/a"}ms) is >= ${MIN_TIMEOUT_MS}ms (20min, well above the 10min/600000ms default)`,
		timeoutValue != null && timeoutValue >= MIN_TIMEOUT_MS,
		`parsed timeoutMs=${timeoutValue}`,
	);
}

// ---------------------------------------------------------------------------
// 1) Nodo codegen: timeoutMs explícito por encima del default.
// ---------------------------------------------------------------------------
checkExplicitTimeout("workflow-codegen");

// ---------------------------------------------------------------------------
// 2) Nodo refine: timeoutMs explícito por encima del default.
// ---------------------------------------------------------------------------
checkExplicitTimeout("workflow-refine");

// ---------------------------------------------------------------------------
// 3) Guard fail-fast: un throw que cita evidencia timeout/empty queda estrictamente entre
//    `let code = extractJs(implement)` y `phase("Review")`.
// ---------------------------------------------------------------------------
const EXTRACT_MARK = "let code = extractJs(implement);";
const REVIEW_PHASE_MARK = 'phase("Review");';

const extractIdx = src.indexOf(EXTRACT_MARK);
check(`\`${EXTRACT_MARK}\` found`, extractIdx !== -1);

const reviewPhaseIdx = src.indexOf(REVIEW_PHASE_MARK);
check(`\`${REVIEW_PHASE_MARK}\` found`, reviewPhaseIdx !== -1);

const orderingOk = extractIdx !== -1 && reviewPhaseIdx !== -1 && extractIdx < reviewPhaseIdx;
check(
	`codegen extractJs() assignment comes BEFORE ${REVIEW_PHASE_MARK} (string index ordering)`,
	orderingOk,
	`extractIdx=${extractIdx} reviewPhaseIdx=${reviewPhaseIdx}`,
);

const between = orderingOk ? src.slice(extractIdx, reviewPhaseIdx) : "";
const guardMatch = orderingOk ? /throw\s+new\s+Error\([\s\S]*?\);/.exec(between) : null;
const guardText = guardMatch ? guardMatch[0] : "";

check(
	`a \`throw new Error(...)\` guard sits strictly between "${EXTRACT_MARK}" and "${REVIEW_PHASE_MARK}"`,
	guardMatch !== null,
	orderingOk ? "no throw found in that span" : "span could not be computed (markers missing/misordered)",
);
check(
	"the guard's throw message cites BOTH the timeout and empty-output evidence",
	/timeout/i.test(guardText) && /empty/i.test(guardText),
	guardText ? `guard: ${guardText.slice(0, 200)}` : "no guard text captured",
);

console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
if (counts.failed) {
	console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
	process.exit(1);
}
