import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

/** Codex receives explicit model ids; portable tiers are intentionally not guessed. */
export function resolveCodexModel(model) {
	return { model, warning: undefined };
}

/** Build a shell-free, ephemeral, read-only Codex exec invocation. */
export function buildCodexCommand({
	command = "codex",
	commandArgs = [],
	cwd,
	model,
	lastMessageFile,
	outputSchemaFile,
}) {
	if (!cwd) throw new Error("Codex command requires a workspace cwd.");
	if (!lastMessageFile) throw new Error("Codex command requires an output path inside the run artifacts.");
	const args = [
		...commandArgs,
		"exec",
		"--cd",
		cwd,
		"--sandbox",
		"read-only",
		"--json",
		"--ephemeral",
		"--ignore-user-config",
		"--output-last-message",
		lastMessageFile,
	];
	if (outputSchemaFile) args.push("--output-schema", outputSchemaFile);
	if (model) args.push("--model", model);
	return { command, args };
}

/** Extract a completed Codex agent message from the JSONL exec event stream. */
export function parseCodexStream(stdout) {
	let output = "";
	let sessionId;
	let terminal = false;
	let failure;
	for (const raw of String(stdout).split(/\r?\n/)) {
		if (!raw.trim()) continue;
		let event;
		try {
			event = JSON.parse(raw);
		} catch {
			continue;
		}
		sessionId ??= event.thread_id ?? event.threadId ?? event.session_id;
		if (event.type === "item.completed" && event.item?.type === "agent_message") {
			output = String(event.item.text ?? event.item.content ?? "");
		}
		if (event.type === "turn.completed") terminal = true;
		if (event.type === "turn.failed" || event.type === "error")
			failure = event.error?.message ?? event.message ?? event.error;
	}
	if (failure) return { ok: false, error: String(failure), sessionId };
	if (!terminal) return { ok: false, error: "Codex emitted no terminal completion event.", sessionId };
	return { ok: true, output, sessionId };
}

/** Spawn Codex without a shell, retaining raw output and preferring its final-message file. */
export async function invokeCodex({ command, args, prompt, cwd, env, signal, timeoutMs = 120_000, lastMessageFile }) {
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
		child.once("error", (error) => finish({ ok: false, error: `Could not start Codex: ${error.message}` }));
		child.once("close", async (code, childSignal) => {
			if (signal?.aborted) return finish({ ok: false, error: "Codex call cancelled." });
			if (code !== 0) return finish({ ok: false, error: `Codex exited ${code ?? childSignal ?? "unknown"}.` });
			const parsed = parseCodexStream(stdout);
			if (!parsed.ok) return finish(parsed);
			const finalMessage = lastMessageFile ? await fs.readFile(lastMessageFile, "utf8").catch(() => "") : "";
			finish({ ok: true, output: finalMessage.trim() || parsed.output, sessionId: parsed.sessionId });
		});
	});
}
