/**
 * The real LLM runner for `/rename` summarization: spawn the `pi` CLI in print mode
 * (`pi -p "<prompt>"`, "print response and exit") and return its stdout.
 *
 * The pi SDK exposes no completion/generate-text API, so a one-shot subprocess is the
 * mechanism (mirroring how pi-dynamic-workflows calls the model). The subprocess is
 * isolated — `--no-extensions/--no-skills/--no-context-files` keeps it fast and avoids
 * recursively loading this very extension. The binary is `pi` on PATH unless overridden
 * by PI_RENAME_PI_COMMAND; the model is the user's default unless PI_RENAME_MODEL is set.
 *
 * Kept separate from summarize-name.ts (which is pure + injectable) so that module's
 * orchestration/fallback logic stays unit-testable without spawning anything. This file
 * deliberately duplicates a small spawn helper rather than importing one from another
 * extension, per the self-contained-extension rule.
 */

import { spawn } from "node:child_process";

/** Default cap so a hung/slow model can never block `/rename` forever. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 12_000;
const KILL_GRACE_MS = 1_000;
const MAX_STDOUT_CHARS = 20_000;

export interface PiSummaryOptions {
	cwd?: string;
	model?: string;
	timeoutMs?: number;
}

/** Build the `pi -p …` argument vector. Pure, so it is unit-testable. Prompt goes last. */
export function buildPiSummaryArgs(prompt: string, opts: { model?: string } = {}): string[] {
	const args = ["-p", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve"];
	if (opts.model) args.push("--model", opts.model);
	args.push(prompt);
	return args;
}

/**
 * Run the summary prompt through `pi -p` and resolve its stdout. Rejects on spawn error,
 * a non-zero exit, or the timeout — summarizeSessionName turns any rejection into the
 * deterministic fallback.
 */
export async function runPiSummary(prompt: string, opts: PiSummaryOptions = {}): Promise<string> {
	const command = process.env.PI_RENAME_PI_COMMAND || "pi";
	const model = opts.model ?? process.env.PI_RENAME_MODEL ?? undefined;
	const args = buildPiSummaryArgs(prompt, { model });
	return await new Promise<string>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		}, opts.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS);
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			fn();
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > MAX_STDOUT_CHARS) stdout = stdout.slice(-MAX_STDOUT_CHARS);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
		child.on("close", (code) =>
			finish(() =>
				code === 0 ? resolve(stdout) : reject(new Error(`pi -p exited ${code}: ${stderr.slice(0, 200)}`)),
			),
		);
	});
}
