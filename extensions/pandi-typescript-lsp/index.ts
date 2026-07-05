/**
 * pandi-typescript-lsp: feedback de diagnósticos de TypeScript que se dispara en
 * el BORDE COHERENTE (`agent_end`), acotado a los archivos que el turno realmente
 * tocó.
 *
 * Esto NO es un Language Server completo: no hay hover, go-to-definition ni
 * completions. El único contrato es el *feedback de diagnósticos*: después de que
 * el agente termina un turno que escribió/editó TypeScript, corremos `tsc --noEmit`
 * sobre el/los proyecto(s) relevante(s), conservamos solo los errores de los
 * archivos tocados y mostramos un reporte top-N acotado. Está diseñado para no
 * bloquear (nunca `block`ea una invocación de tool).
 *
 * Superficies (la convención del proyecto; ver pandi-worktree / pandi-auto-compact):
 *   - feedback automático en `agent_end` (advisory por omisión; autofix opcional)
 *   - herramienta `typescript_diagnostics` invocable por el modelo (pull, a demanda)
 *   - comando `/tsc` para personas (`status`/`on`/`off`/`run`/`scope`/…)
 *
 * `tsc` siempre se spawnea con un array ARGV (nunca un shell string), igual que
 * pandi-worktree hace spawn de `git`, así que las rutas nunca pueden inyectar
 * comandos de shell. Si no se encuentra ni un tsconfig ni un tsc utilizable, la
 * extensión queda en NO-OP con una sola advertencia advisory; nunca rompe la sesión.
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

// Reexportado para que la suite de integración pruebe los helpers puros directamente
// contra el mismo paquete (un re-export `export … from` no crea binding local,
// así que no choca con el import de arriba).
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

// Los parsers de settings viven en settings.ts (refleja la separación de
// diagnostics.ts); se reexportan acá para que la superficie pública de la
// extensión quede idéntica.
export { parseMax, parseMode, parseOnOff, parseScope } from "./settings.js";

/** Tipo de mensaje personalizado propio de esta extensión (para dedupe/renderizado). */
const CUSTOM_TYPE = "pandi-typescript-lsp";
const MAX_TSC_OUTPUT_BYTES = 2_000_000;
/** Presupuesto predeterminado de autofix por prompt: como mucho un turno de arreglo auto-disparado. */
const DEFAULT_AUTOFIX_BUDGET = 1;

// --------------------------------------------------------------------------
// ejecutor de tsc: array argv, nunca un shell (refleja el runGit de pandi-worktree)
// --------------------------------------------------------------------------

interface RunTscOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Corré `command args…` (una invocación de tsc ya resuelta) en `cwd` y resolvé
 * con un resultado tipado. NUNCA rechaza: falla de spawn, exit no cero, timeout
 * o abort vuelven todos como un TscRunResult. La salida está acotada por bytes
 * para que un tsc desbocado no inunde la memoria.
 *
 * Exportado para la suite de integración (refleja el runContainer de
 * pandi-container): ahí quedan pineadas contra spawns REALES las mecánicas de
 * timeout/abort/spawn-error.
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
				/* ya no existe */
			}
			finish({ ok: false, exitCode: null, stdout, stderr, signal: "SIGTERM", timedOut: false });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* ya no existe */
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
 * Corré tsc para un solo tsconfig y devolvé los diagnósticos parseados con sus
 * rutas de archivo resueltas a absolutas (tsc emite rutas relativas a su cwd).
 *
 * Está tipado por outcome para que "no engine" y "timed out" sean DISTINTOS de
 * "clean": una corrida que nunca terminó no debe mostrarse nunca como un check
 * limpio (#10). El presupuesto de tiempo real se lee por spawn desde
 * PI_TS_LSP_TIMEOUT_MS (igual que PI_TS_LSP_TSC), así la suite puede forzar un
 * timeout real.
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
// Extensión
// --------------------------------------------------------------------------

export default function typescriptLspExtension(pi: ExtensionAPI): void {
	let enabled = parseOnOff(process.env.PI_TS_LSP) ?? true;
	let mode: FeedbackMode = parseMode(process.env.PI_TS_LSP_MODE) ?? "advisory";
	let maxErrors = parseMax(process.env.PI_TS_LSP_MAX) ?? DEFAULT_MAX_ERRORS;
	let autofix = parseOnOff(process.env.PI_TS_LSP_AUTOFIX) ?? false;
	let scope: Scope = "touched";

	// Set por prompt de archivos TS tocados (absolutos). Se trackea en
	// tool_result, se consume y se limpia en agent_end.
	const touched = new Set<string>();
	// Solo una corrida de tsc en vuelo por vez.
	let running = false;
	// Deduplicación: última clave de diagnósticos que mostramos (se limpia cuando el proyecto queda limpio).
	let lastKey: string | undefined;
	// Presupuesto de autofix por prompt.
	let autofixBudget = DEFAULT_AUTOFIX_BUDGET;
	// Advertencia NO-OP de una sola vez (sin tsconfig/tsc) por sesión.
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
			"pandi-typescript-lsp: no se encontró tsconfig.json ni tsc — diagnósticos de TypeScript deshabilitados para esta sesión.",
			"warning",
		);
	};

	/**
	 * Agrupá `files` por tsconfig más cercano, corré tsc por grupo y devolvé los
	 * diagnósticos filtrados a esos archivos. "no-engine" (no se encontró tsconfig /
	 * no se puede hacer spawn de tsc) y "timeout" (ALGÚN grupo agotó el tiempo; los
	 * resultados parciales mentirían) son distintos de "clean" (ok con un array vacío).
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

	/** Corré una verificación de proyecto completa contra `<cwd>/tsconfig.json` (sin filtro de tocados). */
	const runProjectCheck = async (ctx: ExtensionContext): Promise<CheckOutcome> => {
		const tsconfig = path.join(ctx.cwd, "tsconfig.json");
		if (!existsSync(tsconfig)) return { status: "no-engine" };
		return checkProject(tsconfig, ctx.signal);
	};

	// --- rastreador: registrá archivos TS tocados. NUNCA chequear acá. ----------
	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		const name = event.toolName;
		if (name !== "write" && name !== "edit" && name !== "multi_edit") return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !isTsFile(raw)) return;
		touched.add(path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw));
	});

	// --- reseteá el presupuesto de autofix por prompt al inicio de cada prompt. -
	pi.on("agent_start", () => {
		autofixBudget = DEFAULT_AUTOFIX_BUDGET;
	});

	// --- borde coherente: corré la verificación después de que el turno termine por completo. -
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
		// Gateá sobre el predicado puro para que siga siendo testeable de forma unitaria.
		if (
			!shouldRun({
				touched: touched.size,
				aborted: ctx.signal?.aborted ?? false,
				idle: ctx.isIdle(),
				pending: ctx.hasPendingMessages(),
			})
		) {
			// No está idle o hay mensajes en cola: conservá `touched` y reintentá en un borde posterior.
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
				// No se verificó nada: conservá lastKey para que un reporte ya mostrado
				// no se vuelva a enviar cuando tsc funcione de nuevo, y avisalo en vez de quedar en silencio.
				notify(ctx, `pandi-typescript-lsp: ${TIMEOUT_MESSAGE}`, "warning");
				return;
			}
			const diags = outcome.diags;
			const formatted = formatDiagnostics(diags, { maxErrors });
			if (!formatted.hasErrors) {
				lastKey = undefined;
				return;
			}
			const key = diagnosticsKey(diags);
			if (key === lastKey) return; // reporte idéntico ya mostrado

			if (mode === "autofix" && autofix) {
				// No contamines el estado de dedupe cuando el presupuesto bloquea la
				// entrega: recordá una clave solo para los reportes que realmente enviamos.
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

	// --- herramienta: typescript_diagnostics (pull / a demanda) ---------------------
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

	// --- comando: /tsc -------------------------------------------------------
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
