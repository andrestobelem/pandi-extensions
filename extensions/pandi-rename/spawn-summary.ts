/**
 * El runner real del LLM para el resumen de `/rename`: ejecuta el CLI `pi` en modo print
 * (`pi -p "<prompt>"`, "print response and exit") y devuelve su stdout.
 *
 * El SDK de pi no expone una API de completion/generate-text, así que un subprocess de un solo tiro es el
 * mecanismo (refleja cómo pandi-dynamic-workflows llama al modelo). El subprocess está
 * aislado — `--no-extensions/--no-skills/--no-context-files` lo mantiene rápido y evita
 * cargar recursivamente esta misma extensión. El binario es `pi` en PATH salvo que
 * PI_RENAME_PI_COMMAND lo sobrescriba; el modelo es el predeterminado del usuario salvo que PI_RENAME_MODEL esté definido.
 *
 * Se mantiene separado de summarize-name.ts (que es puro + inyectable) para que la lógica de
 * orquestación/respaldo de ese módulo siga siendo testeable sin spawnear nada. Este archivo
 * duplica a propósito un pequeño helper de spawn en vez de importarlo de otra
 * extensión, por la regla de extensión autocontenida.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/**
 * Nombre del binario de la distribución HOST, leído del package.json del host: la primera
 * clave de `bin` cuando existe ("pi" en pi vanilla, "picante" en pi-cante), o si no
 * piConfig.name (las distros pueden renombrar el binario independientemente del nombre del producto).
 * Hace fallback a "pi". Duplicado a propósito por extensión (regla de extensión autocontenida).
 */
function hostBinName(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as {
			bin?: string | Record<string, string>;
			piConfig?: { name?: string };
		};
		if (pkg.bin && typeof pkg.bin === "object") {
			const first = Object.keys(pkg.bin)[0];
			if (first) return first;
		}
		return pkg.piConfig?.name || "pi";
	} catch {
		return "pi";
	}
}

/** Tope por defecto para que un modelo colgado/lento nunca pueda bloquear `/rename` para siempre. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 12_000;
const KILL_GRACE_MS = 1_000;
const MAX_STDOUT_CHARS = 20_000;

export interface PiSummaryOptions {
	cwd?: string;
	model?: string;
	timeoutMs?: number;
}

/** Arma el vector de argumentos de `pi -p …`. Es puro, así que es testeable. El prompt va al final. */
export function buildPiSummaryArgs(prompt: string, opts: { model?: string } = {}): string[] {
	const args = ["-p", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve"];
	if (opts.model) args.push("--model", opts.model);
	args.push(prompt);
	return args;
}

/**
 * Corre el prompt de resumen por `pi -p` y resuelve su stdout. Rechaza ante error de spawn,
 * salida no cero o timeout — summarizeSessionName convierte cualquier rechazo en el
 * respaldo determinístico.
 */
export async function runPiSummary(prompt: string, opts: PiSummaryOptions = {}): Promise<string> {
	// Por defecto usa el binario propio de la distribución HOST (bin name === piConfig.name); si hay env override, gana ese.
	const command = process.env.PI_RENAME_PI_COMMAND || hostBinName();
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
