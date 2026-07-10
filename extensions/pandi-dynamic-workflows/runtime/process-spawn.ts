/**
 * Núcleo de spawn de child-process para pandi-dynamic-workflows.
 *
 * runProcess (buffered, timeout + gracia de kill) y runStreamingAgentProcess (streaming live
 * de stdout/stderr con journaling acotado) — las dos primitivas de subprocess usadas
 * para lanzar subprocesses de agentes y la CLI de mermaid. Hoja muy cohesiva.
 *
 * MAX_JOURNALED_STREAM y PROCESS_KILL_GRACE_MS vienen de runtime-constants.ts.
 * ProcessResult (la forma de resultado de runProcess) se define y exporta acá; index.ts
 * lo importa de vuelta como tipo. index.ts importa ambas funciones run* de vuelta y las reexporta
 * para el test de composición. spawn viene de node:child_process.
 */
import { spawn } from "node:child_process";
import { MAX_JOURNALED_STREAM, PROCESS_KILL_GRACE_MS } from "./constants.js";

export interface ProcessResult {
	ok: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: string;
	timedOut?: boolean;
}

export async function runProcess(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; killGraceMs?: number },
): Promise<ProcessResult> {
	return await new Promise<ProcessResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let finished = false;
		let timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString("utf8");
			return next.length > 20_000 ? next.slice(-20_000) : next;
		};
		const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			// Escalá a SIGKILL si el child ignora SIGTERM, para que la promesa no pueda colgarse para siempre.
			killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? PROCESS_KILL_GRACE_MS);
		}, options.timeoutMs);
		const finish = (result: ProcessResult) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			resolve(result);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (err) =>
			finish({
				ok: false,
				code: null,
				signal: null,
				stdout,
				stderr,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
		child.on("close", (code, signal) => finish({ ok: code === 0, code, signal, stdout, stderr, timedOut }));
	});
}

export interface StreamingProcessResult {
	code: number;
	killed: boolean;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	stdoutChars: number;
	stderrChars: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

export async function runStreamingAgentProcess(
	command: string,
	args: string[],
	options: {
		cwd: string;
		timeoutMs: number;
		signal: AbortSignal;
		killGraceMs?: number;
		/** Env del child. Pasá el env completo (p. ej. { ...process.env, ...overrides }); undefined hereda. */
		env?: NodeJS.ProcessEnv;
		onStdout?: (chunk: Buffer) => void | Promise<void>;
		onStderr?: (chunk: Buffer) => void | Promise<void>;
	},
): Promise<StreamingProcessResult> {
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let stdoutChars = 0;
		let stderrChars = 0;
		let killed = false;
		// True solo cuando el TIMEOUT mató al child (no un abort/pérdida de race), para que
		// los callers puedan nombrar el presupuesto en artifacts en vez de un exit code mudo.
		let timedOut = false;
		let finished = false;
		const append = (current: string, chunkText: string, options: { preserveLineBoundary?: boolean } = {}) => {
			const next = current + chunkText;
			if (next.length <= MAX_JOURNALED_STREAM) return next;
			const tail = next.slice(-MAX_JOURNALED_STREAM);
			if (!options.preserveLineBoundary) return tail;
			const newline = tail.indexOf("\n");
			return newline >= 0 ? tail.slice(newline + 1) : tail;
		};
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			killed = true;
			child.kill("SIGTERM");
			// Escalá a SIGKILL si el child ignora SIGTERM, para nunca filtrar el proceso ni retener
			// el semáforo de agentes indefinidamente.
			if (!killTimer)
				killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? PROCESS_KILL_GRACE_MS);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		const onAbort = () => kill();
		options.signal.addEventListener("abort", onAbort, { once: true });
		// Una señal ya abortada ANTES de adjuntar el listener nunca dispara "abort"
		// (p. ej. un perdedor de race() cuyo abort se propagó durante setup). Matá explícitamente para que
		// el gasto de tokens del perdedor se detenga en vez de correr hasta completarse. kill() es
		// idempotente (protege el timer de SIGKILL), así que el handler de close sigue correcto.
		if (options.signal.aborted) kill();
		const finish = (err: Error | undefined, code = 1) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else
				resolve({
					code,
					killed,
					timedOut,
					stdout,
					stderr,
					stdoutChars,
					stderrChars,
					stdoutTruncated: stdoutChars > stdout.length,
					stderrTruncated: stderrChars > stderr.length,
				});
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			const chunkText = chunk.toString("utf8");
			stdoutChars += chunkText.length;
			stdout = append(stdout, chunkText, { preserveLineBoundary: true });
			void options.onStdout?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const chunkText = chunk.toString("utf8");
			stderrChars += chunkText.length;
			stderr = append(stderr, chunkText);
			void options.onStderr?.(chunk);
		});
		child.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
		child.on("close", (code, signal) => finish(undefined, code ?? (signal ? 143 : 1)));
	});
}
