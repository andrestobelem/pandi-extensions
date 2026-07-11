/**
 * Handlers de hooks de sesión (lógica; el wiring vive en index.ts).
 */

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { diagnosticsKey, formatDiagnostics, isTsFile, shouldRun } from "./diagnostics.js";
import { advisoryMessage, autofixMessage } from "./messages.js";
import { TIMEOUT_MESSAGE } from "./runner.js";
import { CUSTOM_TYPE, DEFAULT_AUTOFIX_BUDGET, type TypescriptLspRuntime } from "./runtime.js";

export function onToolResult(
	runtime: TypescriptLspRuntime,
	event: { isError: boolean; toolName: string; input: unknown },
	ctx: ExtensionContext,
): void {
	if (event.isError) return;
	const name = event.toolName;
	if (name !== "write" && name !== "edit" && name !== "multi_edit") return;
	const raw = (event.input as { path?: unknown }).path;
	if (typeof raw !== "string" || !isTsFile(raw)) return;
	runtime.touched.add(path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw));
}

export function onAgentStart(runtime: TypescriptLspRuntime): void {
	if (runtime.awaitingAutofixFollowUp) {
		runtime.awaitingAutofixFollowUp = false;
		return;
	}
	runtime.autofixBudget = DEFAULT_AUTOFIX_BUDGET;
}

export async function onAgentEnd(runtime: TypescriptLspRuntime, _event: unknown, ctx: ExtensionContext): Promise<void> {
	if (!runtime.enabled) {
		runtime.touched.clear();
		return;
	}
	if (runtime.touched.size === 0) return;
	if (ctx.signal?.aborted) {
		runtime.touched.clear();
		return;
	}
	if (
		!shouldRun({
			touched: runtime.touched.size,
			aborted: ctx.signal?.aborted ?? false,
			idle: ctx.isIdle(),
			pending: ctx.hasPendingMessages(),
		})
	) {
		return;
	}
	if (runtime.running) return;
	runtime.running = true;
	try {
		const files = [...runtime.touched];
		const outcome = await runtime.runTouchedCheck(ctx, files);
		if (outcome.status === "no-engine") {
			runtime.warnNoEngine(ctx);
			return;
		}
		if (outcome.status === "timeout") {
			runtime.notify(ctx, `pandi-typescript-lsp: ${TIMEOUT_MESSAGE}`, "warning");
			return;
		}
		const diags = outcome.diags;
		const formatted = formatDiagnostics(diags, { maxErrors: runtime.maxErrors });
		if (!formatted.hasErrors) {
			runtime.lastKey = undefined;
			return;
		}
		const key = diagnosticsKey(diags);
		if (key === runtime.lastKey) return;

		if (runtime.mode === "autofix" && runtime.autofix) {
			if (runtime.autofixBudget <= 0) return;
			runtime.autofixBudget -= 1;
			runtime.lastKey = key;
			runtime.awaitingAutofixFollowUp = true;
			runtime.pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: autofixMessage(formatted),
					display: true,
					details: { kind: "autofix", count: diags.length, diagnostics: diags },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}

		runtime.lastKey = key;
		runtime.pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: advisoryMessage(formatted),
				display: true,
				details: { kind: "advisory", count: diags.length, diagnostics: diags },
			},
			{ deliverAs: "nextTurn" },
		);
	} finally {
		runtime.running = false;
		runtime.touched.clear();
	}
}
