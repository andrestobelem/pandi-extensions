/**
 * Utilidades puras + un único punto de ejecución para la extensión pandi-kitty.
 *
 * kitty expone su protocolo de control remoto vía `kitty @ <subcomando>`. Solo funciona
 * desde una sesión de kitty en ejecución con `allow_remote_control` habilitado, y habla
 * con esa instancia por un socket local.
 *   - `runKitty` lanza `kitty` con un array ARGV (nunca un string de shell).
 *   - `build*Args` son constructores puros de argv (testeados exactamente).
 *   - los manejadores `run*` reciben una fn `run` inyectada para que el despacho sea
 *     determinista en tests sin necesitar una sesión de kitty real.
 */

import { spawn } from "node:child_process";

// --------------------------------------------------------------------------
// Punto de spawn
// --------------------------------------------------------------------------

export interface KittyResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode?: number;
	timedOut?: boolean;
	/** Se setea cuando nunca logramos hacer spawn de `kitty` (ej. no está instalado). */
	spawnError?: string;
}

export interface RunKittyOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Binario a ejecutar; redefinible para que los tests apunten a un nombre garantizadamente ausente. */
	bin?: string;
}

export const DEFAULT_KITTY_TIMEOUT_MS = 15_000;
export const MIN_KITTY_TIMEOUT_MS = 1_000;

export function parseTimeoutMs(raw: string | undefined, fallback = DEFAULT_KITTY_TIMEOUT_MS): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(MIN_KITTY_TIMEOUT_MS, Math.floor(n));
}

/** Firma compartida por runKitty y el runner simulado inyectado en tests. */
export type RunKitty = (args: string[], options?: RunKittyOptions) => Promise<KittyResult>;

/**
 * Hace spawn de `kitty @ ...` con un array argv. Falla de spawn, exit no cero, timeout o
 * abort vuelven como un KittyResult (nunca lanza).
 */
export function runKitty(args: string[], options: RunKittyOptions = {}): Promise<KittyResult> {
	const { cwd, signal, timeoutMs = DEFAULT_KITTY_TIMEOUT_MS, bin = "kitty" } = options;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const child = spawn(bin, ["@", ...args], { cwd, windowsHide: true });

		const finish = (result: KittyResult) => {
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

// --------------------------------------------------------------------------
// Constructores de argv (puros)
// --------------------------------------------------------------------------

export const WINDOW_TYPES = ["tab", "os-window", "window"] as const;
export type WindowType = (typeof WINDOW_TYPES)[number];

export const SPLIT_LOCATIONS = ["vsplit", "hsplit"] as const;
export type SplitLocation = (typeof SPLIT_LOCATIONS)[number];

export interface LaunchOptions {
	type: WindowType;
	location?: SplitLocation;
	cwd?: string;
}

export function buildLaunchArgs(opts: LaunchOptions): string[] {
	const args = ["launch", "--type", opts.type];
	if (opts.location) args.push("--location", opts.location);
	if (opts.cwd) args.push("--cwd", opts.cwd);
	return args;
}

export function buildGotoLayoutArgs(layout: string): string[] {
	return ["goto-layout", layout];
}

export function buildCloseWindowArgs(opts: { matchId?: string } = {}): string[] {
	const args = ["close-window"];
	if (opts.matchId) args.push("--match", `id:${opts.matchId}`);
	return args;
}

export function buildFocusWindowArgs(matchId: string): string[] {
	return ["focus-window", "--match", `id:${matchId}`];
}

// --------------------------------------------------------------------------
// Normalización de errores
// --------------------------------------------------------------------------

const NOT_RUNNING_HINT =
	"No se pudo hablar con kitty por el socket de control remoto. Verificá que estés dentro de una sesión de kitty y que `allow_remote_control yes` esté en kitty.conf (o iniciá kitty con -o allow_remote_control=yes).";

/** Convierte un KittyResult fallido en una sola línea acotada y accionable. */
export function describeError(result: KittyResult, action: string): string {
	if (result.spawnError) {
		if (/ENOENT/i.test(result.spawnError)) return "No se encontró el binario `kitty` en el PATH.";
		return `No se pudo ejecutar \`kitty @ ${action}\`: ${result.spawnError}`;
	}
	if (result.timedOut) return `\`kitty @ ${action}\` agotó el tiempo de espera.`;
	const detail = (result.stderr || result.stdout || "").trim();
	if (/no such remote control socket|could not connect|is kitty running/i.test(detail)) return NOT_RUNNING_HINT;
	return detail
		? `\`kitty @ ${action}\` falló: ${detail}`
		: `\`kitty @ ${action}\` falló (salida ${result.exitCode ?? "?"}).`;
}

// --------------------------------------------------------------------------
// Manejadores de alto nivel (reciben un runner inyectado; por lo demás, despacho puro)
// --------------------------------------------------------------------------

export interface HandlerResult {
	ok: boolean;
	text: string;
	details: Record<string, unknown>;
}

export interface HandlerOpts {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function handlerError(action: string, text: string): HandlerResult {
	return { ok: false, text, details: { isError: true, action } };
}

function isWindowType(type: string): type is WindowType {
	return (WINDOW_TYPES as readonly string[]).includes(type);
}

function isSplitLocation(location: string): location is SplitLocation {
	return (SPLIT_LOCATIONS as readonly string[]).includes(location);
}

export async function runLaunch(
	run: RunKitty,
	params: { type: string; location?: string; cwd?: string },
	opts: HandlerOpts,
): Promise<HandlerResult> {
	if (!isWindowType(params.type)) {
		return handlerError(
			"launch",
			`Tipo de ventana desconocido "${params.type}". Tipos válidos: ${WINDOW_TYPES.join(", ")}.`,
		);
	}
	if (params.location && !isSplitLocation(params.location)) {
		return handlerError(
			"launch",
			`Ubicación de split desconocida "${params.location}". Ubicaciones válidas: ${SPLIT_LOCATIONS.join(", ")}.`,
		);
	}
	const result = await run(
		buildLaunchArgs({ type: params.type, location: params.location as SplitLocation | undefined, cwd: params.cwd }),
		opts,
	);
	if (!result.ok) {
		return handlerError("launch", describeError(result, "launch"));
	}
	const id = result.stdout.trim();
	return {
		ok: true,
		text: `Se abrió ${params.type} nueva (id ${id || "?"}).`,
		details: { action: "launch", type: params.type, location: params.location, id },
	};
}

export async function runGotoLayout(
	run: RunKitty,
	params: { layout: string },
	opts: HandlerOpts,
): Promise<HandlerResult> {
	if (!params.layout) {
		return handlerError("goto-layout", "goto-layout requiere un nombre de layout.");
	}
	const result = await run(buildGotoLayoutArgs(params.layout), opts);
	if (!result.ok) {
		return handlerError("goto-layout", describeError(result, "goto-layout"));
	}
	return {
		ok: true,
		text: `Layout activo: ${params.layout}.`,
		details: { action: "goto-layout", layout: params.layout },
	};
}

export async function runCloseWindow(
	run: RunKitty,
	params: { matchId?: string },
	opts: HandlerOpts,
): Promise<HandlerResult> {
	const result = await run(buildCloseWindowArgs(params), opts);
	if (!result.ok) {
		return handlerError("close-window", describeError(result, "close-window"));
	}
	return {
		ok: true,
		text: params.matchId ? `Se cerró la ventana ${params.matchId}.` : "Se cerró la ventana activa.",
		details: { action: "close-window", matchId: params.matchId },
	};
}

export async function runFocusWindow(
	run: RunKitty,
	params: { matchId: string },
	opts: HandlerOpts,
): Promise<HandlerResult> {
	if (!params.matchId) {
		return handlerError("focus-window", "focus-window requiere un id de ventana.");
	}
	const result = await run(buildFocusWindowArgs(params.matchId), opts);
	if (!result.ok) {
		return handlerError("focus-window", describeError(result, "focus-window"));
	}
	return {
		ok: true,
		text: `Foco en la ventana ${params.matchId}.`,
		details: { action: "focus-window", matchId: params.matchId },
	};
}
