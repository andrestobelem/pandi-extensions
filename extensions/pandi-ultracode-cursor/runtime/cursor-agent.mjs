import { spawn } from "node:child_process";

const TIER_ALIASES = new Set(["haiku", "sonnet", "opus", "fable", "cheap", "balanced", "deep"]);

function parseTierModels(value) {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		throw new Error('PANDI_CURSOR_TIER_MODELS must be a JSON object such as {"sonnet":"sonnet-4-thinking"}.');
	}
}

/** Resolve only explicit Cursor model ids. Generic workflow tiers are opt-in configuration. */
export function resolveCursorModel(model, environment = process.env) {
	if (!model) return { model: undefined, warning: undefined };
	const tiers = parseTierModels(environment.PANDI_CURSOR_TIER_MODELS);
	if (TIER_ALIASES.has(model)) {
		if (typeof tiers[model] === "string" && tiers[model]) return { model: tiers[model], warning: undefined };
		return {
			model: undefined,
			warning: `Cursor model tier ${JSON.stringify(model)} was not forwarded; configure PANDI_CURSOR_TIER_MODELS to map it.`,
		};
	}
	return { model, warning: undefined };
}

/** Build a shell-free Cursor invocation. Read-only plan mode is the invariant by default. */
export function buildCursorCommand({
	command = "cursor-agent",
	commandArgs = [],
	cwd,
	model,
	allowWrite = false,
	trustWorkspace = false,
}) {
	if (!cwd) throw new Error("Cursor command requires a workspace cwd.");
	const args = [...commandArgs, "--print", "--output-format", "stream-json"];
	if (allowWrite) {
		// Cursor's default mode permits actions; the runner separately requires an explicit workspace-trust decision.
		args.push("--sandbox", "disabled", "--force");
	} else {
		args.push("--mode", "plan", "--sandbox", "enabled");
	}
	args.push("--workspace", cwd);
	if (trustWorkspace) args.push("--trust");
	if (model) args.push("--model", model);
	return { command, args };
}

/** Extract the terminal result from Cursor's documented stream-json protocol. */
export function parseCursorStream(stdout) {
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
		sessionId ??= event.session_id;
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
	if (!terminal) return { ok: false, error: "Cursor emitted no terminal result event.", sessionId };
	if (terminal.is_error || terminal.subtype === "error") {
		return { ok: false, error: String(terminal.result ?? "Cursor reported an error."), sessionId };
	}
	return { ok: true, output: String(terminal.result ?? assistant), sessionId };
}

/** Spawn Cursor without a shell and terminate it when the workflow signal or timeout fires. */
export async function invokeCursor({ command, args, prompt, cwd, env, signal, timeoutMs = 120_000 }) {
	return await new Promise((resolve) => {
		const child = spawn(command, [...args, prompt], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
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
		child.once("error", (error) => finish({ ok: false, error: `Could not start Cursor: ${error.message}` }));
		child.once("close", (code, childSignal) => {
			if (signal?.aborted) return finish({ ok: false, error: "Cursor call cancelled." });
			if (code !== 0) return finish({ ok: false, error: `Cursor exited ${code ?? childSignal ?? "unknown"}.` });
			const parsed = parseCursorStream(stdout);
			finish(parsed.ok ? { ok: true, output: parsed.output, sessionId: parsed.sessionId } : parsed);
		});
	});
}
