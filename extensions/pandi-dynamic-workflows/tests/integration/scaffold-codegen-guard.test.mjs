#!/usr/bin/env node
/**
 * Regression (#28): workflow-factory's codegen/refine agent nodes ran on the silent
 * DEFAULT_AGENT_TIMEOUT_MS (10min/600000ms — config.ts:19), even though they generate
 * 15-25KB of code at sonnet/medium. On timeout the agent() call returns null, and
 * `extractJs(null)` silently degrades to an EMPTY STRING that then flowed straight
 * into the Review phase — burying the real timeout under a wasted opus review turn
 * ("the workflow code block is completely empty").
 *
 * This pins three things, purely by reading the canonical scaffold source (no model
 * calls, no mutation):
 *
 *   1. node("workflow-codegen", …) carries an explicit `timeoutMs` well above the
 *      10-min default (>= 20*60000 = 1,200,000ms).
 *   2. node("workflow-refine", …) likewise carries an explicit `timeoutMs` above the
 *      default.
 *   3. A fail-fast guard — a `throw` whose message cites the timeout/empty evidence —
 *      sits AFTER `let code = extractJs(implement)` but BEFORE `phase("Review")` /
 *      the review agent call, verified by string index ordering. A null or
 *      whitespace-only codegen result can therefore never reach the review prompt.
 *
 * Mutation-free: reads extensions/pandi-dynamic-workflows/scaffolds/workflow-factory.js
 * and pattern-matches; does not execute the workflow or call any agent.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/scaffold-codegen-guard.test.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createChecker, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

const SCAFFOLDS_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds");
const FACTORY_PATH = path.join(SCAFFOLDS_DIR, "workflow-factory.js");
const src = fs.readFileSync(FACTORY_PATH, "utf8");

// Minimum acceptable per-agent timeout for the codegen/refine roles: well above the
// 600000ms (10min) DEFAULT_AGENT_TIMEOUT_MS, per the issue's "20-30min" guidance.
const MIN_TIMEOUT_MS = 20 * 60_000; // 1_200_000

/** Evaluate a numeric-literal-or-simple-multiplication timeoutMs expression, e.g.
 * "1_200_000" or "20 * 60_000". Returns null when the expression isn't recognized
 * (never throws — an unparsable value should surface as a failing check, not a crash). */
function evalTimeoutExpr(raw) {
	if (raw == null) return null;
	const cleaned = String(raw).replace(/_/g, "").trim();
	if (/^\d+$/.test(cleaned)) return Number(cleaned);
	const m = /^(\d+)\s*\*\s*(\d+)$/.exec(cleaned);
	if (m) return Number(m[1]) * Number(m[2]);
	return null;
}

/** Find `node("<role>", { ...options... })` and return the options-literal text, or
 * null if the call site isn't found. Options objects in this scaffold are flat
 * (no nested braces), so a non-greedy match up to the first `}` is sufficient. */
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
// 1) codegen node: explicit timeoutMs above the default.
// ---------------------------------------------------------------------------
checkExplicitTimeout("workflow-codegen");

// ---------------------------------------------------------------------------
// 2) refine node: explicit timeoutMs above the default.
// ---------------------------------------------------------------------------
checkExplicitTimeout("workflow-refine");

// ---------------------------------------------------------------------------
// 3) fail-fast guard: a throw citing timeout/empty evidence sits strictly between
//    `let code = extractJs(implement)` and `phase("Review")`.
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
