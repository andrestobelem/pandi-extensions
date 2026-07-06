/**
 * Characterization tests for the `/plan` approval handshake helpers.
 *
 * The overlay component has its own integration suite. This pins the higher-level
 * handshake contract: prefer custom overlay, fall back to confirm, and reject stale
 * approval decisions for old submissions.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/approval-handshake-coverage.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildApprovalHandshake() {
	return await buildExtension({
		name: "pi-plan-approval-handshake-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "approval-handshake.ts"),
		outName: "approval-handshake.mjs",
		stubs: { tui: true, sdk: (dir) => sdkStub(dir) },
	});
}

async function staleApproval(url) {
	const { isCurrentPlanApproval, isStalePlanApproval } = await loadModule(url);
	check("isCurrentPlanApproval is exported", typeof isCurrentPlanApproval === "function");
	check("isStalePlanApproval is exported", typeof isStalePlanApproval === "function");

	const live = { planId: "p1", submissions: 2 };
	check("current: matching plan/submission is current", isCurrentPlanApproval(live, "p1", 2) === true);
	check("stale: matching plan/submission is not stale", isStalePlanApproval(live, "p1", 2) === false);
	check("stale: no live plan is stale", isStalePlanApproval(undefined, "p1", 2) === true);
	check("stale: different plan id is stale", isStalePlanApproval(live, "other", 2) === true);
	check("stale: different submission is stale", isStalePlanApproval(live, "p1", 1) === true);
}

async function approvalPresentation(url) {
	const { presentPlanForApproval } = await loadModule(url);
	check("presentPlanForApproval is exported", typeof presentPlanForApproval === "function");

	const confirmCalls = [];
	const fallbackCtx = {
		hasUI: true,
		ui: {
			confirm: async (title, body) => {
				confirmCalls.push({ title, body });
				return true;
			},
		},
	};
	const fallbackApproved = await presentPlanForApproval(fallbackCtx, "fallback plan", "p1");
	check("present: confirm fallback returns approval", fallbackApproved === true);
	check("present: confirm fallback title is stable", confirmCalls[0]?.title === "Approve this plan?");
	check("present: confirm fallback body is plan text", confirmCalls[0]?.body === "fallback plan");

	let customCalled = false;
	let confirmCalledAfterCustom = false;
	const customCtx = {
		hasUI: true,
		ui: {
			custom: async () => {
				customCalled = true;
				return false;
			},
			confirm: async () => {
				confirmCalledAfterCustom = true;
				return true;
			},
		},
	};
	const customApproved = await presentPlanForApproval(customCtx, "custom plan", "p2");
	check("present: custom overlay decision wins", customApproved === false);
	check("present: custom overlay is consulted", customCalled === true);
	check("present: confirm is not called when custom succeeds", confirmCalledAfterCustom === false);

	let fallbackAfterThrowCalled = false;
	const throwingCtx = {
		hasUI: true,
		ui: {
			custom: async () => {
				throw new Error("overlay failed");
			},
			confirm: async () => {
				fallbackAfterThrowCalled = true;
				return false;
			},
		},
	};
	const throwingApproved = await presentPlanForApproval(throwingCtx, "throwing plan", "p3");
	check("present: overlay failure falls back to confirm", fallbackAfterThrowCalled === true);
	check("present: fallback decision after overlay failure is preserved", throwingApproved === false);
}

async function main() {
	const { outDir, url } = await buildApprovalHandshake();
	try {
		await staleApproval(url);
		await approvalPresentation(url);
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
