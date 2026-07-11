/**
 * Ejecutor de tsc: array argv, nunca shell (refleja runGit de pandi-worktree).
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import {
	buildTscArgs,
	DEFAULT_TSC_TIMEOUT_MS,
	type Diagnostic,
	parseTscDiagnostics,
	resolveTscCommand,
	type TscRunResult,
} from "./diagnostics.js";
import { parseMax } from "./settings.js";

export const MAX_TSC_OUTPUT_BYTES = 2_000_000;

export const TIMEOUT_MESSAGE =
	"El chequeo de TypeScript agotó el tiempo de espera — resultados no concluyentes. Reintentá cuando tsc termine, o aumentá PI_TS_LSP_TIMEOUT_MS.";

export interface RunTscOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Corré `command args…` en `cwd`. NUNCA rechaza: spawn/exit/timeout/abort → TscRunResult.
 * Exportado para la suite de integración (mecánicas reales de timeout/abort/spawn-error).
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

export type CheckOutcome = { status: "ok"; diags: Diagnostic[] } | { status: "no-engine" } | { status: "timeout" };

/** Corré tsc para un tsconfig y devolvé diagnósticos con rutas absolutas. */
export async function checkProject(tsconfigPath: string, signal: AbortSignal | undefined): Promise<CheckOutcome> {
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

export function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}
