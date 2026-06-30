/**
 * Characterization suite for extensions/pi-plan/prompts.ts — the PURE prompt builders.
 *
 * Why this file exists
 * --------------------
 * `plan-approval.test.mjs` drives the prompt text only INDIRECTLY, through the
 * enter_plan_mode / submit_plan handshake in index.ts (it asserts "PLAN MODE",
 * "ULTRACODE:", "Implement now" appear). It never pins the EXACT structure of the
 * canonical wording that prompts.ts owns:
 *
 *   1. makePlanningPrompt: the literal "TASK (verbatim):" header followed by the task
 *      injected VERBATIM (no escaping/truncation, multi-line preserved), the planId in
 *      the opening line, and the conditional NON-INTERACTIVE / ULTRACODE / ULTRACODE
 *      STEPS / AskUserQuestion blocks that the posture flags toggle.
 *   2. makeImplementPrompt: the "Plan approved. Implement now:\n\n<plan>" base and the
 *      ultracodeSteps suffix.
 *
 * prompts.ts is PURE (no imports at all — not even `import type`), so this suite builds it
 * with NO stubs and exercises the EXPORTED functions directly. It asserts the source's
 * CURRENT real behavior (characterization): if an expectation is wrong, the test is fixed,
 * never the source.
 *
 * Run it:    node extensions/pi-plan/tests/integration/prompts-coverage.test.mjs
 * Exit code: 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pi-plan/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// prompts.ts is a pure module (zero imports) → no stubs needed.
async function buildPrompts() {
	return await buildExtension({
		name: "pi-plan-prompts-coverage",
		src: path.join(REPO_ROOT, "extensions", "pi-plan", "prompts.ts"),
		outName: "prompts.mjs",
		npx: "--yes",
	});
}

// ===========================================================================
// makePlanningPrompt
// ===========================================================================
function planningPromptTests(mod) {
	const { makePlanningPrompt } = mod;
	check("makePlanningPrompt is exported", typeof makePlanningPrompt === "function");

	// --- The flagged gap: task injected VERBATIM under "TASK (verbatim):" ---
	{
		const task = "Migrate DB & drop *old* tables\nline2";
		const out = makePlanningPrompt({ planId: "abc12345", task });
		// Header followed IMMEDIATELY by the exact task, then a blank line — no escaping.
		check(
			"planning: 'TASK (verbatim):' header is followed immediately by the exact task",
			out.includes(`TASK (verbatim):\n${task}\n`),
		);
		// The raw task substring (special chars + newline) survives untouched.
		check("planning: task special characters are not escaped", out.includes("Migrate DB & drop *old* tables"));
		check("planning: multi-line task second line is preserved verbatim", out.includes("\nline2\n"));
		// Not truncated: the entire task substring is present as one contiguous block.
		const idx = out.indexOf("TASK (verbatim):\n");
		check("planning: task block is contiguous (not split/truncated)", out.slice(idx).includes(task));
	}

	// --- planId appears in the opening line ---
	{
		const out = makePlanningPrompt({ planId: "deadbeef", task: "x" });
		check("planning: opening line names PLAN MODE", out.startsWith("You are now in PLAN MODE"));
		check("planning: opening line embeds the planId", out.includes("(plan deadbeef)"));
		check("planning: states READ-ONLY posture", /READ-ONLY planning posture/.test(out));
	}

	// --- default (interactive, no posture flags) ---
	{
		const out = makePlanningPrompt({ planId: "p1", task: "ship it" });
		check("planning(default): NO non-interactive block", !/NON-INTERACTIVE/.test(out));
		check("planning(default): NO ULTRACODE wording", !/ULTRACODE/.test(out));
		check("planning(default): offers AskUserQuestion (interactive)", /AskUserQuestion/.test(out));
		check("planning(default): has the WHAT TO DO section", /WHAT TO DO:/.test(out));
		check("planning(default): mentions submit_plan for approval", /submit_plan/.test(out));
		check("planning(default): interactive step3 mentions approval", /presents it to the user for approval/.test(out));
	}

	// --- nonInteractive flag ---
	{
		const out = makePlanningPrompt({ planId: "p2", task: "t", nonInteractive: true });
		check(
			"planning(nonInteractive): includes NON-INTERACTIVE block",
			/NON-INTERACTIVE \(plan-only\) SESSION:/.test(out),
		);
		check("planning(nonInteractive): says NO human approval", /NO human approval/.test(out));
		check("planning(nonInteractive): drops AskUserQuestion", !/AskUserQuestion/.test(out));
		check("planning(nonInteractive): step3 says the plan IS the result", /The plan IS the result/.test(out));
	}

	// --- ultracode flag ---
	{
		const out = makePlanningPrompt({ planId: "p3", task: "t", ultracode: true });
		check("planning(ultracode): includes 'ULTRACODE:' guidance", /ULTRACODE: lean on dynamic workflows/.test(out));
		check("planning(ultracode): does NOT include ULTRACODE STEPS", !/ULTRACODE STEPS/.test(out));
	}

	// --- ultracodeSteps flag ---
	{
		const out = makePlanningPrompt({ planId: "p4", task: "t", ultracodeSteps: true });
		check(
			"planning(ultracodeSteps): includes 'ULTRACODE STEPS' guidance",
			/ULTRACODE STEPS: structure the plan/.test(out),
		);
	}

	// --- both ultracode posture knobs together ---
	{
		const out = makePlanningPrompt({ planId: "p5", task: "t", ultracode: true, ultracodeSteps: true });
		check("planning(both): includes ULTRACODE:", /ULTRACODE: lean on dynamic workflows/.test(out));
		check("planning(both): includes ULTRACODE STEPS:", /ULTRACODE STEPS: structure the plan/.test(out));
	}

	// --- result is a joined string of lines (no array leakage) ---
	{
		const out = makePlanningPrompt({ planId: "p6", task: "t" });
		check("planning: returns a string", typeof out === "string");
		check("planning: lines joined with newlines", out.includes("\n") && !out.includes(",You"));
	}
}

// ===========================================================================
// makeImplementPrompt
// ===========================================================================
function implementPromptTests(mod) {
	const { makeImplementPrompt } = mod;
	check("makeImplementPrompt is exported", typeof makeImplementPrompt === "function");

	// --- base (no opts) ---
	{
		const planText = "# Plan\n1. do X & verify *carefully*";
		const out = makeImplementPrompt(planText);
		check(
			"implement(base): starts with 'Plan approved. Implement now:'",
			out.startsWith("Plan approved. Implement now:"),
		);
		check(
			"implement(base): plan text follows a blank line, verbatim",
			out === `Plan approved. Implement now:\n\n${planText}`,
		);
		check("implement(base): no ultracode suffix by default", !/dynamic_workflow/.test(out));
	}

	// --- opts.ultracodeSteps = false (explicit) is same as base ---
	{
		const planText = "# Plan\nstep";
		const out = makeImplementPrompt(planText, { ultracodeSteps: false });
		check("implement(steps=false): equals the base form", out === `Plan approved. Implement now:\n\n${planText}`);
	}

	// --- opts.ultracodeSteps = true appends the dynamic_workflow suffix ---
	{
		const planText = "# Plan\nstep";
		const out = makeImplementPrompt(planText, { ultracodeSteps: true });
		check(
			"implement(steps=true): keeps the base prefix",
			out.startsWith(`Plan approved. Implement now:\n\n${planText}`),
		);
		check(
			"implement(steps=true): appends dynamic_workflow guidance",
			/Execute the steps marked for ultracode via dynamic_workflow/.test(out),
		);
		check("implement(steps=true): mentions concurrency/maxAgents", /concurrency\/maxAgents/.test(out));
		check("implement(steps=true): plan text still present verbatim", out.includes(planText));
	}
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildPrompts();
	try {
		const mod = await loadModule(url);
		planningPromptTests(mod);
		implementPromptTests(mod);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
