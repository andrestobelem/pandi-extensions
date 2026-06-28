/**
 * Child-process spawn kernel for pi-dynamic-workflows.
 *
 * runProcess (buffered, timeout + kill-grace) and runStreamingAgentProcess (live
 * stdout/stderr streaming with bounded journaling) — the two subprocess primitives
 * used to launch agent subprocesses and the mermaid CLI. Highly cohesive leaf.
 *
 * Deferred bidirectional cycle with index.ts: imports MAX_JOURNALED_STREAM and
 * PROCESS_KILL_GRACE_MS (values, read only inside the run* bodies) from ./index.js.
 * ProcessResult (runProcess's result shape) is defined and exported here; index.ts
 * imports it back as a type. index.ts imports both run* functions back and re-exports
 * them for the composition test. spawn comes from node:child_process.
 */
import { spawn } from "node:child_process";
import { MAX_JOURNALED_STREAM, PROCESS_KILL_GRACE_MS } from "./index.js";

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
			// Escalate to SIGKILL if the child ignores SIGTERM, so the promise can't hang forever.
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

export async function runStreamingAgentProcess(
	command: string,
	args: string[],
	options: {
		cwd: string;
		timeoutMs: number;
		signal: AbortSignal;
		killGraceMs?: number;
		onStdout?: (chunk: Buffer) => void | Promise<void>;
		onStderr?: (chunk: Buffer) => void | Promise<void>;
	},
): Promise<{ code: number; killed: boolean; stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let killed = false;
		let finished = false;
		const append = (current: string, chunk: Buffer, options: { preserveLineBoundary?: boolean } = {}) => {
			const next = current + chunk.toString("utf8");
			if (next.length <= MAX_JOURNALED_STREAM) return next;
			const tail = next.slice(-MAX_JOURNALED_STREAM);
			if (!options.preserveLineBoundary) return tail;
			const newline = tail.indexOf("\n");
			return newline >= 0 ? tail.slice(newline + 1) : tail;
		};
		const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			killed = true;
			child.kill("SIGTERM");
			// Escalate to SIGKILL if the child ignores SIGTERM, so we never leak the process or hold
			// the agent semaphore indefinitely.
			if (!killTimer)
				killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? PROCESS_KILL_GRACE_MS);
		};
		const timer = setTimeout(kill, options.timeoutMs);
		const onAbort = () => kill();
		options.signal.addEventListener("abort", onAbort, { once: true });
		const finish = (err: Error | undefined, code = 1) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve({ code, killed, stdout, stderr });
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk, { preserveLineBoundary: true });
			void options.onStdout?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
			void options.onStderr?.(chunk);
		});
		child.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
		child.on("close", (code, signal) => finish(undefined, code ?? (signal ? 143 : 1)));
	});
}
