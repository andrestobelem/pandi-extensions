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
const CUSTOM_TYPE = "pi-typescript-lsp";
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
 */
function runTsc(command: string, args: string[], options: RunTscOptions): Promise<TscRunResult> {
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
 * paths resolved to absolute (tsc emits paths relative to its cwd). Returns
 * `null` only when tsc could not be spawned at all, so callers can warn once.
 */
async function checkProject(
	tsconfigPath: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<Diagnostic[] | null> {
	const dir = path.dirname(tsconfigPath);
	const cmd = resolveTscCommand(dir, process.env);
	const args = [...cmd.args, ...buildTscArgs(tsconfigPath)];
	const result = await runTsc(cmd.command, args, { cwd: dir, signal, timeoutMs });
	if (result.spawnError) return null;
	const parsed = parseTscDiagnostics(`${result.stdout}\n${result.stderr}`);
	return parsed.map((d) => ({
		...d,
		file: path.isAbsolute(d.file) ? d.file : path.resolve(dir, d.file),
	}));
}

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
			"pi-typescript-lsp: no tsconfig.json or tsc found — TypeScript diagnostics disabled for this session.",
			"warning",
		);
	};

	/**
	 * Group `files` by nearest tsconfig, run tsc per group, and return diagnostics
	 * filtered to those files. `null` means there was no engine to run (no tsconfig
	 * found, or tsc could not be spawned) — distinct from "clean" (empty array).
	 */
	const runTouchedCheck = async (ctx: ExtensionContext, files: string[]): Promise<Diagnostic[] | null> => {
		const groups = new Map<string, string[]>();
		for (const file of files) {
			const tsconfig = findNearestTsconfig(file, ctx.cwd);
			if (!existsSync(tsconfig)) continue;
			const list = groups.get(tsconfig) ?? [];
			list.push(file);
			groups.set(tsconfig, list);
		}
		if (groups.size === 0) return null;

		const all: Diagnostic[] = [];
		let spawned = false;
		for (const [tsconfig, groupFiles] of groups) {
			const diags = await checkProject(tsconfig, ctx.signal, DEFAULT_TSC_TIMEOUT_MS);
			if (diags === null) continue;
			spawned = true;
			all.push(...filterToTouched(diags, groupFiles));
		}
		return spawned ? all : null;
	};

	/** Run a whole-project check against `<cwd>/tsconfig.json` (no touched filter). */
	const runProjectCheck = async (ctx: ExtensionContext): Promise<Diagnostic[] | null> => {
		const tsconfig = path.join(ctx.cwd, "tsconfig.json");
		if (!existsSync(tsconfig)) return null;
		return checkProject(tsconfig, ctx.signal, DEFAULT_TSC_TIMEOUT_MS);
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
			const diags = await runTouchedCheck(ctx, files);
			if (diags === null) {
				warnNoEngine(ctx);
				return;
			}
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
			"Run TypeScript diagnostics (tsc --noEmit) on demand and return the errors. scope='touched' (default) checks only files written/edited so far this turn; scope='project' type-checks the whole project (<cwd>/tsconfig.json). This is diagnostics feedback only — not a full language server (no hover/go-to-definition). tsc is invoked with an argv array, never a shell.",
		promptSnippet: "Type-check touched files or the project with typescript_diagnostics.",
		promptGuidelines: [
			"Use typescript_diagnostics to verify your TypeScript edits compile (tsc --noEmit) instead of hand-writing `tsc` or `npx tsc` bash commands.",
			"Prefer scope='touched' to check just the files you changed; use scope='project' for a full type-check before declaring done.",
			"typescript_diagnostics reports diagnostics only — it cannot do hover, go-to-definition, or completions.",
		],
		parameters: Type.Object({
			scope: Type.Optional(
				StringEnum(["touched", "project"] as const, {
					description:
						"'touched' (default): only files edited so far this turn. 'project': the whole <cwd>/tsconfig.json.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const requested = parseScope(params.scope) ?? scope;
			const effectiveCtx: ExtensionContext = { ...ctx, signal: signal ?? ctx.signal };

			let diags: Diagnostic[] | null;
			if (requested === "project") {
				diags = await runProjectCheck(effectiveCtx);
			} else {
				if (touched.size === 0) {
					return {
						content: [{ type: "text" as const, text: "No TypeScript files have been touched this turn." }],
						details: { scope: "touched", count: 0, diagnostics: [] },
					};
				}
				diags = await runTouchedCheck(effectiveCtx, [...touched]);
			}

			if (diags === null) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No tsconfig.json or tsc found — cannot run TypeScript diagnostics.",
						},
					],
					details: { isError: true, scope: requested },
				};
			}

			const formatted = formatDiagnostics(diags, { maxErrors });
			const text = formatted.hasErrors
				? `TypeScript diagnostics (${diags.length}):\n${formatted.text}`
				: "No TypeScript diagnostics — clean.";
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
			"TypeScript diagnostics: status | on | off | run | scope <touched|project> | autofix <on|off> | max <n>",
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
					`TypeScript diagnostics: ${enabled ? "on" : "off"}; mode: ${mode}; scope: ${scope}; autofix: ${autofix ? "on" : "off"}; max: ${maxErrors}`,
					"info",
				);
				return;
			}

			if (head === "on") {
				enabled = true;
				lastKey = undefined;
				notify(ctx, "TypeScript diagnostics enabled.", "info");
				return;
			}

			if (head === "off") {
				enabled = false;
				touched.clear();
				notify(ctx, "TypeScript diagnostics disabled.", "warning");
				return;
			}

			if (head === "scope") {
				const next = parseScope(tokens[1]);
				if (!next) {
					notify(ctx, "Usage: /tsc scope <touched|project>", "warning");
					return;
				}
				scope = next;
				notify(ctx, `TypeScript diagnostics scope: ${scope}`, "info");
				return;
			}

			if (head === "autofix") {
				const next = parseOnOff(tokens[1]);
				if (next === undefined) {
					notify(ctx, "Usage: /tsc autofix <on|off>", "warning");
					return;
				}
				autofix = next;
				mode = autofix ? "autofix" : "advisory";
				notify(ctx, `TypeScript diagnostics autofix: ${autofix ? "on" : "off"}`, "info");
				return;
			}

			if (head === "max") {
				const next = parseMax(tokens[1]);
				if (next === undefined) {
					notify(ctx, "Usage: /tsc max <positive integer>", "warning");
					return;
				}
				maxErrors = next;
				notify(ctx, `TypeScript diagnostics max errors: ${maxErrors}`, "info");
				return;
			}

			if (head === "run") {
				const diags = scope === "project" ? await runProjectCheck(ctx) : await runTouchedCheck(ctx, [...touched]);
				if (diags === null) {
					notify(
						ctx,
						scope === "touched" && touched.size === 0
							? "No TypeScript files touched this turn."
							: "No tsconfig.json or tsc found — cannot run TypeScript diagnostics.",
						"warning",
					);
					return;
				}
				const formatted = formatDiagnostics(diags, { maxErrors });
				notify(
					ctx,
					formatted.hasErrors
						? `TypeScript diagnostics (${diags.length}):\n${formatted.text}`
						: "No TypeScript diagnostics — clean.",
					formatted.hasErrors ? "warning" : "info",
				);
				return;
			}

			notify(ctx, "Usage: /tsc [status|on|off|run|scope <touched|project>|autofix <on|off>|max <n>]", "warning");
		},
	});
}
