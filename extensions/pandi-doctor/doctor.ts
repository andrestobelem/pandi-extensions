/**
 * Helpers puros + un único punto de inyección del spawn para la extensión pandi-doctor.
 *
 *   - `runDoctor` ejecuta `node <scripts/doctor.mjs>` con un array ARGV (nunca un
 *     shell string). Fallo de spawn, salida no cero, timeout o abort vuelven como un
 *     DoctorResult (nunca lanza), igual que `runContainer` de pandi-container.
 *   - `resolveDoctorScript` ubica el chequeo read-only de entorno SIN importarlo
 *     (un import estático rompería el bundling), prefiriendo la copia del WORKING TREE
 *     (sube desde el cwd de la sesión hasta extensions/pandi-doctor/scripts/doctor.mjs,
 *     así el desarrollo dentro del repo siempre corre la versión más nueva), y luego
 *     cae en la copia vendorizada propia de la extensión `<extDir>/scripts/doctor.mjs`
 *     — que viaja en el npm tarball, así que una instalación independiente igual resuelve.
 *     Devuelve null cuando no existe ninguna.
 *   - `runDoctorCheck` es el paso de alto nivel inyectable que llama el command
 *     handler; `formatDoctorOutput` mapea un DoctorResult a texto + severidad para
 *     notify.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DoctorResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode?: number;
	/** se marca cuando el proceso se termina por timeout/abort. */
	timedOut?: boolean;
	/** se marca cuando nunca logramos hacer spawn de `node`. */
	spawnError?: string;
}

export interface RunDoctorOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** binario a ejecutar; se puede sobrescribir para que los tests apunten a un nombre garantizadamente ausente. */
	bin?: string;
}

export const DEFAULT_DOCTOR_TIMEOUT_MS = 120_000;
export const MIN_DOCTOR_TIMEOUT_MS = 1_000;

export function parseTimeoutMs(raw: string | undefined, fallback = DEFAULT_DOCTOR_TIMEOUT_MS): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(MIN_DOCTOR_TIMEOUT_MS, Math.floor(n));
}

/** Firma compartida por `runDoctor` y el runner falso inyectado en tests. */
export type RunDoctor = (scriptPath: string, options?: RunDoctorOptions) => Promise<DoctorResult>;

/**
 * Ejecuta `node <scriptPath>` (el `scripts/doctor.mjs` vendorizado). Fallo de spawn,
 * salida no cero, timeout o abort siempre resuelven a un DoctorResult (nunca lanza).
 */
export function runDoctor(scriptPath: string, options: RunDoctorOptions = {}): Promise<DoctorResult> {
	const { cwd, signal, timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS, bin = "node" } = options;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		// NO_COLOR para que el reporte capturado sea texto plano (`doctor.mjs` también omite ANSI cuando va por pipe).
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

/** Dónde vive el script doctor vendorizado, relativo a la raíz de la suite/working tree. */
const VENDORED_SCRIPT_REL = join("extensions", "pandi-doctor", "scripts", "doctor.mjs");

/**
 * Ubicá el script doctor: subí desde `startCwd` buscando una copia del working tree
 * (`<root>/extensions/pandi-doctor/scripts/doctor.mjs` — el desarrollo dentro del repo
 * gana incluso cuando la extensión cargó desde otra identidad de instalación), y si
 * no, caé en la copia vendorizada propia de la extensión (`<extDir>/scripts/doctor.mjs`,
 * incluida en el npm tarball). Devuelve null cuando no existe ninguna — `/doctor` se
 * degrada a una sugerencia.
 */
export function resolveDoctorScript(startCwd: string, extDir: string): string | null {
	let dir = startCwd;
	// Subí hasta la raíz del filesystem.
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
	"No se encontró `scripts/doctor.mjs` — corré `/doctor` desde dentro del repo pandi-extensions (o usá `npm run doctor`).";

/** Mapea un DoctorResult a texto + severidad para notify. */
export function formatDoctorOutput(result: DoctorResult): { text: string; type: "info" | "warning" | "error" } {
	if (result.spawnError) {
		return { text: `No se pudo ejecutar el chequeo del doctor: ${result.spawnError}`, type: "error" };
	}
	if (result.timedOut) {
		return {
			text: "El chequeo del doctor superó el tiempo límite — corré `npm run doctor` directamente para darle más tiempo.",
			type: "error",
		};
	}
	const text = result.stdout.trim() || result.stderr.trim() || "(el doctor no produjo salida)";
	return { text, type: result.ok ? "info" : "error" };
}

/**
 * Paso de alto nivel que llama el command handler. Resuelve el script, lo corre con
 * el runner inyectado y devuelve texto + type listos para notify. Nunca lanza.
 */
export async function runDoctorCheck(
	run: RunDoctor,
	opts: { cwd: string; extDir: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ ok: boolean; text: string; type: "info" | "warning" | "error" }> {
	const script = resolveDoctorScript(opts.cwd, opts.extDir);
	if (!script) return { ok: false, text: NOT_IN_REPO_HINT, type: "warning" };
	// Hace spawn con el cwd de la sesión: `doctor.mjs` descubre la raíz de la suite desde ahí.
	const result = await run(script, { cwd: opts.cwd, signal: opts.signal, timeoutMs: opts.timeoutMs });
	const { text, type } = formatDoctorOutput(result);
	return { ok: result.ok, text, type };
}
