/**
 * pi-typescript-lsp: TypeScript diagnostics feedback that fires on the COHERENT
 * EDGE (agent_end), scoped to the files the turn actually touched.
 *
 * This is NOT a full Language Server — there is no hover, no go-to-definition,
 * no completions. The single contract is *diagnostics feedback*: after the agent
 * finishes a turn that wrote/edited TypeScript, we run `tsc --noEmit` on the
 * relevant project(s), keep only the touched files' errors, and surface a bounded
 * top-N report. It is non-blocking by design (never `block`s a tool call).
 *
 * Surfaces (the project convention — see pi-worktree / pi-auto-compact):
 *   - automatic feedback on `agent_end` (advisory by default; opt-in autofix)
 *   - `typescript_diagnostics`  model-callable tool (pull, on-demand)
 *   - `/tsc`                    human slash command (status/on/off/run/scope/…)
 *
 * `tsc` is always spawned with an ARGV array (never a shell string), exactly as
 * pi-worktree spawns `git`, so paths can never inject shell commands. If neither
 * a tsconfig nor a usable tsc can be found, the extension is a NO-OP with a
 * single advisory warning — it never breaks the session.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildTscArgs,
	DEFAULT_MAX_ERRORS,
	DEFAULT_TSC_TIMEOUT_MS,
	type Diagnostic,
	diagnosticsKey,
	filterToTouched,
	findNearestTsconfig,
	formatDiagnostics,
	isTsFile,
	parseTscDiagnostics,
	resolveTscCommand,
	shouldRun,
	type TscRunResult,
} from "./diagnostics.js";
import { advisoryMessage, autofixMessage } from "./messages.js";
import { type FeedbackMode, parseMax, parseMode, parseOnOff, parseScope, type Scope } from "./settings.js";

// Re-exported for the integration suite to unit-test the pure helpers directly
// against the same bundle (an `export … from` re-export creates no local binding,
// so there is no clash with the import above).
export {
	buildTscArgs,
	diagnosticsKey,
	filterToTouched,
	findNearestTsconfig,
	formatDiagnostics,
	isTsFile,
	parseTscDiagnostics,
	resolveTscCommand,
	shouldRun,
} from "./diagnostics.js";

// Setting parsers live in settings.ts (mirrors the diagnostics.ts split); re-exported
// here so the extension's public surface stays identical.
export { parseMax, parseMode, parseOnOff, parseScope } from "./settings.js";

/** Custom message type owned by this extension (for dedupe/rendering). */
const CUSTOM_TYPE = "pandi-typescript-lsp";
const MAX_TSC_OUTPUT_BYTES = 2_000_000;
/** Default autofix budget per prompt: at most one auto-triggered fix turn. */
const DEFAULT_AUTOFIX_BUDGET = 1;

// --------------------------------------------------------------------------
// tsc runner — argv array, never a shell (mirrors pi-worktree's runGit)
// --------------------------------------------------------------------------

interface RunTscOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Run `command args…` (a resolved tsc invocation) in `cwd` and resolve with a
 * typed result. NEVER rejects: spawn failure, non-zero exit, timeout, or abort
 * all come back as a TscRunResult. Output is byte-bounded so a runaway tsc cannot
 * flood memory.
 *
 * Exported for the integration suite (mirrors pi-container's runContainer): the
 * timeout/abort/spawn-error mechanics are pinned against REAL spawns there.
 */
export function runTsc(command: string, args: string[], options: RunTscOptions): Promise<TscRunResult> {
	const { cwd, signal, timeoutMs = DEFAULT_TSC_TIMEOUT_MS } = options;
	return new Promise<TscRunResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timedOut = false;

		const child = spawn(command, args, { cwd, windowsHide: true });

		const finish = (result: TscRunResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const onAbort = (): void => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			finish({ ok: false, exitCode: null, stdout, stderr, signal: "SIGTERM", timedOut: false });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();

		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutBytes >= MAX_TSC_OUTPUT_BYTES) return;
			stdoutBytes += chunk.length;
			stdout += chunk.toString("utf8");
			if (stdoutBytes > MAX_TSC_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_TSC_OUTPUT_BYTES);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes >= MAX_TSC_OUTPUT_BYTES) return;
			stderrBytes += chunk.length;
			stderr += chunk.toString("utf8");
			if (stderrBytes > MAX_TSC_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_TSC_OUTPUT_BYTES);
		});

		child.on("error", (err) => {
			finish({
				ok: false,
				exitCode: null,
				stdout,
				stderr,
				signal: null,
				timedOut,
				spawnError: err.message,
			});
		});
		child.on("close", (code, sig) => {
			finish({
				ok: code === 0 && !timedOut,
				exitCode: code,
				stdout,
				stderr,
				signal: sig,
				timedOut,
			});
		});
	});
}

/**
 * Run tsc for a single tsconfig and return the parsed diagnostics with their file
 * paths resolved to absolute (tsc emits paths relative to its cwd).
 *
 * Outcome-typed so "no engine" and "timed out" are DISTINCT from "clean": a run
 * that never finished must never be surfaced as a clean check (#10). The wall
 * budget is read per spawn from PI_TS_LSP_TIMEOUT_MS (like PI_TS_LSP_TSC), so
 * the suite can force a real timeout.
 */
type CheckOutcome = { status: "ok"; diags: Diagnostic[] } | { status: "no-engine" } | { status: "timeout" };

async function checkProject(tsconfigPath: string, signal: AbortSignal | undefined): Promise<CheckOutcome> {
	const dir = path.dirname(tsconfigPath);
	const cmd = resolveTscCommand(dir, process.env);
	const args = [...cmd.args, ...buildTscArgs(tsconfigPath)];
	const timeoutMs = parseMax(process.env.PI_TS_LSP_TIMEOUT_MS) ?? DEFAULT_TSC_TIMEOUT_MS;
	const result = await runTsc(cmd.command, args, { cwd: dir, signal, timeoutMs });
	if (result.spawnError) return { status: "no-engine" };
	if (result.timedOut) return { status: "timeout" };
	const parsed = parseTscDiagnostics(`${result.stdout}\n${result.stderr}`);
	return {
		status: "ok",
		diags: parsed.map((d) => ({
			...d,
			file: path.isAbsolute(d.file) ? d.file : path.resolve(dir, d.file),
		})),
	};
}

const TIMEOUT_MESSAGE =
	"El chequeo de TypeScript agotó el tiempo de espera — resultados no concluyentes. Reintentá cuando tsc termine, o aumentá PI_TS_LSP_TIMEOUT_MS.";

// --------------------------------------------------------------------------
// Extension
// --------------------------------------------------------------------------

export default function typescriptLspExtension(pi: ExtensionAPI): void {
	let enabled = parseOnOff(process.env.PI_TS_LSP) ?? true;
	let mode: FeedbackMode = parseMode(process.env.PI_TS_LSP_MODE) ?? "advisory";
	let maxErrors = parseMax(process.env.PI_TS_LSP_MAX) ?? DEFAULT_MAX_ERRORS;
	let autofix = parseOnOff(process.env.PI_TS_LSP_AUTOFIX) ?? false;
	let scope: Scope = "touched";

	// Per-prompt set of touched TS files (absolute). Tracked in tool_result,
	// consumed and cleared in agent_end.
	const touched = new Set<string>();
	// Only one tsc check in flight at a time.
	let running = false;
	// Dedupe: last diagnostics key we surfaced (cleared when the project is clean).
	let lastKey: string | undefined;
	// Per-prompt autofix budget.
	let autofixBudget = DEFAULT_AUTOFIX_BUDGET;
	// One-time NO-OP warning (no tsconfig/tsc) per session.
	let warnedNoEngine = false;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.mode === "print") {
			(level === "info" ? console.log : console.error)(message);
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
			return;
		}
		if (level !== "info") console.error(message);
	};

	const warnNoEngine = (ctx: ExtensionContext): void => {
		if (warnedNoEngine) return;
		warnedNoEngine = true;
		notify(
			ctx,
			"pi-typescript-lsp: no se encontró tsconfig.json ni tsc — diagnósticos de TypeScript deshabilitados para esta sesión.",
			"warning",
		);
	};

	/**
	 * Group `files` by nearest tsconfig, run tsc per group, and return diagnostics
	 * filtered to those files. "no-engine" (no tsconfig found / tsc unspawnable) and
	 * "timeout" (ANY group timed out — partial results would be a lie) are distinct
	 * from "clean" (ok with an empty array).
	 */
	const runTouchedCheck = async (ctx: ExtensionContext, files: string[]): Promise<CheckOutcome> => {
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
	};

	/** Run a whole-project check against `<cwd>/tsconfig.json` (no touched filter). */
	const runProjectCheck = async (ctx: ExtensionContext): Promise<CheckOutcome> => {
		const tsconfig = path.join(ctx.cwd, "tsconfig.json");
		if (!existsSync(tsconfig)) return { status: "no-engine" };
		return checkProject(tsconfig, ctx.signal);
	};

	// --- tracker: record touched TS files. NEVER check here. ----------------
	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		const name = event.toolName;
		if (name !== "write" && name !== "edit" && name !== "multi_edit") return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !isTsFile(raw)) return;
		touched.add(path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw));
	});

	// --- reset the per-prompt autofix budget at the start of each prompt. ----
	pi.on("agent_start", () => {
		autofixBudget = DEFAULT_AUTOFIX_BUDGET;
	});

	// --- coherent edge: run the check after the turn fully finishes. ---------
	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled) {
			touched.clear();
			return;
		}
		if (touched.size === 0) return;
		if (ctx.signal?.aborted) {
			touched.clear();
			return;
		}
		// Gate on the pure predicate so it stays unit-testable.
		if (
			!shouldRun({
				touched: touched.size,
				aborted: ctx.signal?.aborted ?? false,
				idle: ctx.isIdle(),
				pending: ctx.hasPendingMessages(),
			})
		) {
			// Not idle or messages queued: keep `touched` and retry on a later edge.
			return;
		}
		if (running) return;
		running = true;
		try {
			const files = [...touched];
			const outcome = await runTouchedCheck(ctx, files);
			if (outcome.status === "no-engine") {
				warnNoEngine(ctx);
				return;
			}
			if (outcome.status === "timeout") {
				// Nothing was verified: keep lastKey so an already-surfaced report is
				// not re-sent once tsc works again, and say so instead of staying mute.
				notify(ctx, `pi-typescript-lsp: ${TIMEOUT_MESSAGE}`, "warning");
				return;
			}
			const diags = outcome.diags;
			const formatted = formatDiagnostics(diags, { maxErrors });
			if (!formatted.hasErrors) {
				lastKey = undefined;
				return;
			}
			const key = diagnosticsKey(diags);
			if (key === lastKey) return; // identical report already surfaced

			if (mode === "autofix" && autofix) {
				// Don't poison dedupe state when the budget blocks delivery: only
				// remember a key for reports we actually send.
				if (autofixBudget <= 0) return;
				autofixBudget -= 1;
				lastKey = key;
				pi.sendMessage(
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

			lastKey = key;
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: advisoryMessage(formatted),
					display: true,
					details: { kind: "advisory", count: diags.length, diagnostics: diags },
				},
				{ deliverAs: "nextTurn" },
			);
		} finally {
			running = false;
			touched.clear();
		}
	});

	// --- tool: typescript_diagnostics (pull / on-demand) --------------------
	pi.registerTool({
		name: "typescript_diagnostics",
		label: "TypeScript Diagnostics",
		description:
			"Ejecutá diagnósticos de TypeScript (tsc --noEmit) a pedido y devolvé los errores. scope='touched' (default) chequea solo los archivos escritos/editados en este turno; scope='project' tipa-chequea el proyecto completo (<cwd>/tsconfig.json). Esto es solo feedback de diagnósticos — no un language server completo (sin hover/go-to-definition). tsc se invoca con un array argv, nunca con un shell.",
		promptSnippet: "Tipa-chequeá los archivos tocados o el proyecto con typescript_diagnostics.",
		promptGuidelines: [
			"Usá typescript_diagnostics para verificar que tus ediciones de TypeScript compilan (tsc --noEmit) en vez de escribir a mano comandos bash `tsc` o `npx tsc`.",
			"Preferí scope='touched' para chequear solo los archivos que cambiaste; usá scope='project' para un chequeo de tipos completo antes de dar por terminada la tarea.",
			"typescript_diagnostics solo reporta diagnósticos — no puede hacer hover, go-to-definition, ni completions.",
		],
		parameters: Type.Object({
			scope: Type.Optional(
				StringEnum(["touched", "project"] as const, {
					description:
						"'touched' (default): solo los archivos editados en este turno. 'project': el <cwd>/tsconfig.json completo.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const requested = parseScope(params.scope) ?? scope;
			const effectiveCtx: ExtensionContext = { ...ctx, signal: signal ?? ctx.signal };

			let outcome: CheckOutcome;
			if (requested === "project") {
				outcome = await runProjectCheck(effectiveCtx);
			} else {
				if (touched.size === 0) {
					return {
						content: [{ type: "text" as const, text: "No se tocó ningún archivo TypeScript en este turno." }],
						details: { scope: "touched", count: 0, diagnostics: [] },
					};
				}
				outcome = await runTouchedCheck(effectiveCtx, [...touched]);
			}

			if (outcome.status === "no-engine") {
				return {
					content: [
						{
							type: "text" as const,
							text: "No se encontró tsconfig.json ni tsc — no se pueden ejecutar los diagnósticos de TypeScript.",
						},
					],
					details: { isError: true, scope: requested },
				};
			}
			if (outcome.status === "timeout") {
				return {
					content: [{ type: "text" as const, text: TIMEOUT_MESSAGE }],
					details: { isError: true, timedOut: true, scope: requested },
				};
			}

			const diags = outcome.diags;
			const formatted = formatDiagnostics(diags, { maxErrors });
			const text = formatted.hasErrors
				? `Diagnósticos de TypeScript (${diags.length}):\n${formatted.text}`
				: "No hay diagnósticos de TypeScript — limpio.";
			return {
				content: [{ type: "text" as const, text }],
				details: {
					scope: requested,
					hasErrors: formatted.hasErrors,
					count: diags.length,
					diagnostics: diags,
				},
			};
		},
	});

	// --- command: /tsc -------------------------------------------------------
	const SUBCOMMANDS = ["status", "on", "off", "run", "scope", "autofix", "max"] as const;

	pi.registerCommand("tsc", {
		description:
			"Diagnósticos de TypeScript: status | on | off | run | scope <touched|project> | autofix <on|off> | max <n>",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/);
			if (tokens.length > 1) return null;
			const needle = (tokens[0] ?? "").toLowerCase();
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(needle));
			return items.length > 0 ? items.map((sub) => ({ value: sub, label: sub })) : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const head = (tokens[0] ?? "status").toLowerCase();

			if (head === "status") {
				notify(
					ctx,
					`Diagnósticos de TypeScript: ${enabled ? "on" : "off"}; mode: ${mode}; scope: ${scope}; autofix: ${autofix ? "on" : "off"}; max: ${maxErrors}`,
					"info",
				);
				return;
			}

			if (head === "on") {
				enabled = true;
				lastKey = undefined;
				notify(ctx, "Diagnósticos de TypeScript habilitados.", "info");
				return;
			}

			if (head === "off") {
				enabled = false;
				touched.clear();
				notify(ctx, "Diagnósticos de TypeScript deshabilitados.", "warning");
				return;
			}

			if (head === "scope") {
				const next = parseScope(tokens[1]);
				if (!next) {
					notify(ctx, "Uso: /tsc scope <touched|project>", "warning");
					return;
				}
				scope = next;
				notify(ctx, `Diagnósticos de TypeScript, scope: ${scope}`, "info");
				return;
			}

			if (head === "autofix") {
				const next = parseOnOff(tokens[1]);
				if (next === undefined) {
					notify(ctx, "Uso: /tsc autofix <on|off>", "warning");
					return;
				}
				autofix = next;
				mode = autofix ? "autofix" : "advisory";
				notify(ctx, `Diagnósticos de TypeScript, autofix: ${autofix ? "on" : "off"}`, "info");
				return;
			}

			if (head === "max") {
				const next = parseMax(tokens[1]);
				if (next === undefined) {
					notify(ctx, "Uso: /tsc max <positive integer>", "warning");
					return;
				}
				maxErrors = next;
				notify(ctx, `Diagnósticos de TypeScript, max errors: ${maxErrors}`, "info");
				return;
			}

			if (head === "run") {
				const outcome = scope === "project" ? await runProjectCheck(ctx) : await runTouchedCheck(ctx, [...touched]);
				if (outcome.status === "no-engine") {
					notify(
						ctx,
						scope === "touched" && touched.size === 0
							? "No se tocó ningún archivo TypeScript en este turno."
							: "No se encontró tsconfig.json ni tsc — no se pueden ejecutar los diagnósticos de TypeScript.",
						"warning",
					);
					return;
				}
				if (outcome.status === "timeout") {
					notify(ctx, TIMEOUT_MESSAGE, "warning");
					return;
				}
				const formatted = formatDiagnostics(outcome.diags, { maxErrors });
				notify(
					ctx,
					formatted.hasErrors
						? `Diagnósticos de TypeScript (${outcome.diags.length}):\n${formatted.text}`
						: "No hay diagnósticos de TypeScript — limpio.",
					formatted.hasErrors ? "warning" : "info",
				);
				return;
			}

			notify(ctx, "Uso: /tsc [status|on|off|run|scope <touched|project>|autofix <on|off>|max <n>]", "warning");
		},
	});
}
