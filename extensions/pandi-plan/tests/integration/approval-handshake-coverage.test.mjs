/**
 * Tests de caracterización para los helpers del handshake de aprobación de `/plan`.
 *
 * El componente de overlay ya tiene su propia suite de integración. Acá se pinnea
 * el contrato de más alto nivel del handshake: preferir el overlay custom, caer a
 * `confirm` como fallback y rechazar decisiones de aprobación viejas para envíos
 * anteriores.
 *
 * Ejecutar:    node extensions/pandi-plan/tests/integration/approval-handshake-coverage.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makeTheme() {
	const id = (_color, text) => text;
	return {
		fg: id,
		bold: (text) => text,
		italic: (text) => text,
		underline: (text) => text,
		strikethrough: (text) => text,
	};
}

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
	check("present: confirm fallback title is stable", confirmCalls[0]?.title === "¿Aprobar este plan?");
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

	let timeoutSignalSeen = false;
	const autoFallbackCtx = {
		hasUI: true,
		ui: {
			confirm: async (_title, _body, options) => {
				timeoutSignalSeen = !!options?.signal;
				return await new Promise((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
				});
			},
		},
	};
	const autoFallbackApproved = await presentPlanForApproval(autoFallbackCtx, "timed plan", "p4", {
		autoSubmit: true,
		timeoutMs: 5,
	});
	check("present: auto-submit fallback passes an AbortSignal", timeoutSignalSeen === true);
	check("present: auto-submit fallback approves on timeout", autoFallbackApproved === true);

	const autoFallbackCancelCtx = {
		hasUI: true,
		ui: {
			confirm: async () => false,
		},
	};
	const autoFallbackCancelled = await presentPlanForApproval(autoFallbackCancelCtx, "cancelled plan", "p5", {
		autoSubmit: true,
		timeoutMs: 50,
	});
	check("present: auto-submit fallback preserves human cancel", autoFallbackCancelled === false);

	let autoCustomRendered = "";
	let autoCustomConfirmCalled = false;
	let autoCustomRenders = 0;
	const autoCustomCtx = {
		hasUI: true,
		ui: {
			custom: async (factory) => {
				const tui = {
					terminal: { columns: 80, rows: 20 },
					requestRender: () => {
						autoCustomRenders += 1;
					},
				};
				return await new Promise((resolve) => {
					const component = factory(tui, makeTheme(), {}, resolve);
					autoCustomRendered = component.render(80).join("\n");
				});
			},
			confirm: async () => {
				autoCustomConfirmCalled = true;
				return false;
			},
		},
	};
	const autoCustomApproved = await presentPlanForApproval(autoCustomCtx, "custom timed plan", "p6", {
		autoSubmit: true,
		timeoutMs: 5,
	});
	check("present: auto-submit custom overlay approves on timeout", autoCustomApproved === true);
	check("present: auto-submit custom overlay renders a countdown hint", /auto-submit/i.test(autoCustomRendered));
	check("present: auto-submit custom overlay requested rerender", autoCustomRenders > 0);
	check("present: auto-submit custom overlay does not fall back to confirm", autoCustomConfirmCalled === false);
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
