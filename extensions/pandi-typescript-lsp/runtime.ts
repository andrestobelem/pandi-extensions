/**
 * Estado mutable de sesión y helpers compartidos entre hooks, tool y comando.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_ERRORS, type Diagnostic, filterToTouched, findNearestTsconfig } from "./diagnostics.js";
import { type CheckOutcome, checkProject } from "./runner.js";
import { type FeedbackMode, parseMax, parseMode, parseOnOff, type Scope } from "./settings.js";

/** Presupuesto predeterminado de autofix por prompt: como mucho un turno auto-disparado. */
export const DEFAULT_AUTOFIX_BUDGET = 1;

/** Tipo de mensaje custom para dedupe/renderizado. */
export const CUSTOM_TYPE = "pandi-typescript-lsp";

export interface TypescriptLspRuntime {
	pi: ExtensionAPI;
	enabled: boolean;
	mode: FeedbackMode;
	maxErrors: number;
	autofix: boolean;
	scope: Scope;
	touched: Set<string>;
	running: boolean;
	lastKey: string | undefined;
	autofixBudget: number;
	awaitingAutofixFollowUp: boolean;
	warnedNoEngine: boolean;
	notify: (ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error") => void;
	warnNoEngine: (ctx: ExtensionContext) => void;
	runTouchedCheck: (ctx: ExtensionContext, files: string[]) => Promise<CheckOutcome>;
	runProjectCheck: (ctx: ExtensionContext) => Promise<CheckOutcome>;
}

export function createTypescriptLspRuntime(pi: ExtensionAPI): TypescriptLspRuntime {
	const runtime: TypescriptLspRuntime = {
		pi,
		enabled: parseOnOff(process.env.PI_TS_LSP) ?? true,
		mode: parseMode(process.env.PI_TS_LSP_MODE) ?? "advisory",
		maxErrors: parseMax(process.env.PI_TS_LSP_MAX) ?? DEFAULT_MAX_ERRORS,
		autofix: parseOnOff(process.env.PI_TS_LSP_AUTOFIX) ?? false,
		scope: "touched",
		touched: new Set<string>(),
		running: false,
		lastKey: undefined,
		autofixBudget: DEFAULT_AUTOFIX_BUDGET,
		awaitingAutofixFollowUp: false,
		warnedNoEngine: false,
		notify(ctx, message, level = "info") {
			if (ctx.mode === "print") {
				(level === "info" ? console.log : console.error)(message);
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(message, level);
				return;
			}
			if (level !== "info") console.error(message);
		},
		warnNoEngine(ctx) {
			if (runtime.warnedNoEngine) return;
			runtime.warnedNoEngine = true;
			runtime.notify(
				ctx,
				"pandi-typescript-lsp: no se encontró tsconfig.json ni tsc — diagnósticos de TypeScript deshabilitados para esta sesión.",
				"warning",
			);
		},
		async runTouchedCheck(ctx, files) {
			const groups = new Map<string, string[]>();
			for (const file of files) {
				const tsconfig = findNearestTsconfig(file, ctx.cwd);
				if (!existsSync(tsconfig)) continue;
				const list = groups.get(tsconfig) ?? [];
				list.push(file);
				groups.set(tsconfig, list);
			}
			if (groups.size === 0) return { status: "no-engine" };

			const all: Diagnostic[] = [];
			let spawned = false;
			for (const [tsconfig, groupFiles] of groups) {
				const outcome = await checkProject(tsconfig, ctx.signal);
				if (outcome.status === "timeout") return outcome;
				if (outcome.status === "no-engine") continue;
				spawned = true;
				all.push(...filterToTouched(outcome.diags, groupFiles));
			}
			return spawned ? { status: "ok", diags: all } : { status: "no-engine" };
		},
		async runProjectCheck(ctx) {
			const tsconfig = path.join(ctx.cwd, "tsconfig.json");
			if (!existsSync(tsconfig)) return { status: "no-engine" };
			return checkProject(tsconfig, ctx.signal);
		},
	};

	return runtime;
}
