/**
 * Pure helpers + a single spawn seam for the pi-doctor extension.
 *
 *   - `runDoctor` spawns `node <scripts/doctor.mjs>` with an ARGV array (never a
 *     shell string). Spawn failure, non-zero exit, timeout, or abort all come back
 *     as a DoctorResult (never throws), mirroring pi-container's runContainer.
 *   - `resolveDoctorScript` locates the read-only env check WITHOUT importing it
 *     (a static import would break bundling), preferring the WORKING-TREE copy
 *     (walk up from the session cwd to extensions/pandi-doctor/scripts/doctor.mjs, so
 *     in-repo dev always runs the freshest version), then falling back to the
 *     extension's own vendored `<extDir>/scripts/doctor.mjs` — which ships in the
 *     npm tarball, so a standalone install still resolves. Null when neither does.
 *   - `runDoctorCheck` is the injectable high-level step the command handler calls;
 *     `formatDoctorOutput` maps a DoctorResult to notify text + severity.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DoctorResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode?: number;
	/** set when the process was killed by timeout/abort. */
	timedOut?: boolean;
	/** set when we never managed to spawn `node` at all. */
	spawnError?: string;
}

export interface RunDoctorOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** binary to spawn; overridable so tests can point at a guaranteed-absent name. */
	bin?: string;
}

export const DEFAULT_DOCTOR_TIMEOUT_MS = 120_000;

/** Signature shared by runDoctor and the injected fake runner in tests. */
export type RunDoctor = (scriptPath: string, options?: RunDoctorOptions) => Promise<DoctorResult>;

/**
 * Spawn `node <scriptPath>` (the vendored scripts/doctor.mjs). Spawn failure, non-zero
 * exit, timeout, or abort all resolve to a DoctorResult (never throws).
 */
export function runDoctor(scriptPath: string, options: RunDoctorOptions = {}): Promise<DoctorResult> {
	const { cwd, signal, timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS, bin = "node" } = options;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		// NO_COLOR so the captured report is plain text (doctor.mjs also skips ANSI when piped).
		const child = spawn(bin, [scriptPath], {
			cwd,
			windowsHide: true,
			env: { ...process.env, NO_COLOR: "1" },
		});

		const finish = (result: DoctorResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const onAbort = () => {
			timedOut = true;
			child.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err: Error) => {
			finish({ ok: false, stdout, stderr, spawnError: err.message });
		});
		child.on("close", (code) => {
			finish({ ok: !timedOut && code === 0, stdout, stderr, exitCode: code ?? undefined, timedOut });
		});
	});
}

/** Where the vendored doctor script lives, relative to a suite/working-tree root. */
const VENDORED_SCRIPT_REL = join("extensions", "pandi-doctor", "scripts", "doctor.mjs");

/**
 * Locate the doctor script: walk up from `startCwd` looking for a working-tree
 * copy (`<root>/extensions/pandi-doctor/scripts/doctor.mjs` — in-repo dev wins even
 * when the extension loaded from another install identity), then fall back to the
 * extension's own vendored copy (`<extDir>/scripts/doctor.mjs`, shipped in the npm
 * tarball). Returns null when neither exists — `/doctor` degrades to a hint.
 */
export function resolveDoctorScript(startCwd: string, extDir: string): string | null {
	let dir = startCwd;
	// Walk up to the filesystem root.
	for (;;) {
		const candidate = join(dir, VENDORED_SCRIPT_REL);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const fallback = join(extDir, "scripts", "doctor.mjs");
	if (existsSync(fallback)) return fallback;
	return null;
}

const NOT_IN_REPO_HINT =
	"Could not find `scripts/doctor.mjs` — run `/doctor` from within the pi-dynamic-workflows repo (or use `npm run doctor`).";

/** Map a DoctorResult to notify text + severity. */
export function formatDoctorOutput(result: DoctorResult): { text: string; type: "info" | "warning" | "error" } {
	if (result.spawnError) {
		return { text: `Could not run the doctor check: ${result.spawnError}`, type: "error" };
	}
	if (result.timedOut) {
		return {
			text: "The doctor check timed out — run `npm run doctor` directly for more time to finish.",
			type: "error",
		};
	}
	const text = result.stdout.trim() || result.stderr.trim() || "(doctor produced no output)";
	return { text, type: result.ok ? "info" : "error" };
}

/**
 * High-level step the command handler calls. Resolves the script, runs it via the
 * injected runner, and returns notify-ready text + type. Never throws.
 */
export async function runDoctorCheck(
	run: RunDoctor,
	opts: { cwd: string; extDir: string; signal?: AbortSignal },
): Promise<{ ok: boolean; text: string; type: "info" | "warning" | "error" }> {
	const script = resolveDoctorScript(opts.cwd, opts.extDir);
	if (!script) return { ok: false, text: NOT_IN_REPO_HINT, type: "warning" };
	// Spawn with the SESSION cwd: doctor.mjs discovers the suite root from there.
	const result = await run(script, { cwd: opts.cwd, signal: opts.signal });
	const { text, type } = formatDoctorOutput(result);
	return { ok: result.ok, text, type };
}
