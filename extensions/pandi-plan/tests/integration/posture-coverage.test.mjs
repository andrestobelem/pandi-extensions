/**
 * Characterization tests for the pure `/plan` posture helpers.
 *
 * Posture is the small domain concept behind the flags nonInteractive,
 * ultracode and ultracodeSteps. Runtime mode checks stay in index.ts; this module
 * only captures the behavior-preserving clamp used when human approval exists.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/posture-coverage.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildPosture() {
	return await buildExtension({
		name: "pi-plan-posture-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "posture.ts"),
		outName: "posture.mjs",
		stubs: {},
	});
}

async function postureHelpers(url) {
	const { forceInteractiveApprovalPosture } = await loadModule(url);
	check("forceInteractiveApprovalPosture is exported", typeof forceInteractiveApprovalPosture === "function");

	const input = { nonInteractive: true, ultracode: true, ultracodeSteps: true };
	const clamped = forceInteractiveApprovalPosture(input);
	check("interactive clamp: disables nonInteractive", clamped.nonInteractive === false);
	check("interactive clamp: preserves ultracode", clamped.ultracode === true);
	check("interactive clamp: preserves ultracodeSteps", clamped.ultracodeSteps === true);
	check("interactive clamp: returns a copy", clamped !== input);
	check("interactive clamp: does not mutate input", input.nonInteractive === true);

	const alreadyInteractive = { nonInteractive: false, ultracode: false, ultracodeSteps: true };
	const preserved = forceInteractiveApprovalPosture(alreadyInteractive);
	check("interactive clamp(false): keeps nonInteractive false", preserved.nonInteractive === false);
	check(
		"interactive clamp(false): preserves mixed posture",
		preserved.ultracode === false && preserved.ultracodeSteps === true,
	);
}

async function main() {
	const { outDir, url } = await buildPosture();
	try {
		await postureHelpers(url);
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
