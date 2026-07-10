import { spawn } from "node:child_process";

/** Claude CLI supports its native aliases directly; no cross-provider tier mapping is needed. */
export function resolveClaudeModel(model) {
	return { model, warning: undefined };
}

/**
 * Construye una invocación sin shell y de solo lectura. `--trust-workspace` es
 * una decisión del runner: Claude `--print` no tiene un flag equivalente.
 */
export function buildClaudeCommand({ command = "claude", commandArgs = [], cwd, model, effort, schema }) {
	if (!cwd) throw new Error("Claude command requires a workspace cwd.");
	const args = [
		...commandArgs,
		"--print",
		"--output-format",
		"stream-json",
		"--permission-mode",
		"plan",
		"--tools",
		"Read,Glob,Grep",
		"--safe-mode",
	];
	if (model) args.push("--model", model);
	if (effort) args.push("--effort", effort);
	if (schema) args.push("--json-schema", JSON.stringify(schema));
	return { command, args };
}

/** Extract the terminal answer from Claude's stream-json protocol. */
export function parseClaudeStream(stdout) {
	let assistant = "";
	let sessionId;
	let terminal;
	for (const raw of String(stdout).split(/\r?\n/)) {
		if (!raw.trim()) continue;
		let event;
		try {
			event = JSON.parse(raw);
		} catch {
			continue;
		}
		sessionId ??= event.session_id ?? event.sessionId;
		if (event.type === "assistant") {
			const content = event.message?.content;
			if (Array.isArray(content))
				assistant = content
					.filter((part) => part?.type === "text")
					.map((part) => part.text)
					.join("");
		}
		if (event.type === "result") terminal = event;
	}
	if (!terminal) return { ok: false, error: "Claude emitted no terminal result event.", sessionId };
	if (terminal.is_error || terminal.subtype === "error") {
		return { ok: false, error: String(terminal.result ?? terminal.error ?? "Claude reported an error."), sessionId };
	}
	return { ok: true, output: String(terminal.result ?? assistant), sessionId };
}

/** Spawn Claude without a shell and kill the process on timeout or cancellation. */
export async function invokeClaude({ command, args, prompt, cwd, env, signal, timeoutMs = 120_000 }) {
	return await new Promise((resolve) => {
		const child = spawn(command, [...args, prompt], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			resolve({ ...result, stdout, stderr });
		};
		const terminate = () => {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		};
		const abort = () => terminate();
		const timer = setTimeout(() => terminate(), Math.max(1, timeoutMs));
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("error", (error) => finish({ ok: false, error: `Could not start Claude: ${error.message}` }));
		child.once("close", (code, childSignal) => {
			if (signal?.aborted) return finish({ ok: false, error: "Claude call cancelled." });
			if (code !== 0) return finish({ ok: false, error: `Claude exited ${code ?? childSignal ?? "unknown"}.` });
			const parsed = parseClaudeStream(stdout);
			finish(parsed.ok ? { ok: true, output: parsed.output, sessionId: parsed.sessionId } : parsed);
		});
	});
}
