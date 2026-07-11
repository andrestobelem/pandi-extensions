/**
 * Utilidades puras + un único punto de ejecución para la extensión pandi-container.
 *
 * La CLI `container` de Apple corre Linux en micro-VMs livianas (Virtualization.framework)
 * sobre Apple Silicon. Este módulo la envuelve igual que pandi-worktree envuelve git:
 *   - `runContainer` lanza `container` con un array ARGV (nunca un string de shell),
 *     así las referencias de imagen, los nombres de máquina y los comandos no pueden inyectar shell.
 *   - `build*Args` son constructores puros de argv (testeados exactamente).
 *   - `parseMachineList` / `formatMachineList` parsean el `--format json` de la CLI.
 *   - los manejadores `run*` reciben una fn `run` inyectada para que el despacho + la
 *     barrera de acción destructiva sean deterministas en tests sin arrancar una VM real.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// --------------------------------------------------------------------------
// Punto de spawn
// --------------------------------------------------------------------------

export interface ContainerResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode?: number;
	/** true únicamente cuando venció timeoutMs. */
	timedOut?: boolean;
	/** true únicamente cuando la AbortSignal externa pidió terminar el proceso. */
	aborted?: boolean;
	/** Señal que cerró al hijo, incluida SIGKILL después de agotar la gracia. */
	signal?: NodeJS.Signals;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
	/** Se setea cuando nunca logramos hacer spawn de `container` (ej. no está instalado). */
	spawnError?: string;
}

export interface RunContainerOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Binario a ejecutar; redefinible para que los tests apunten a un nombre garantizadamente ausente. */
	bin?: string;
}

export const DEFAULT_CONTAINER_TIMEOUT_MS = 120_000;
export const MIN_CONTAINER_TIMEOUT_MS = 1_000;
const MAX_CONTAINER_OUTPUT_BYTES = 1_000_000;
const CONTAINER_TERMINATION_GRACE_MS = 250;

export function parseTimeoutMs(raw: string | undefined, fallback = DEFAULT_CONTAINER_TIMEOUT_MS): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(MIN_CONTAINER_TIMEOUT_MS, Math.floor(n));
}

/** Firma compartida por runContainer y el runner simulado inyectado en tests. */
export type RunContainer = (args: string[], options?: RunContainerOptions) => Promise<ContainerResult>;

function createBoundedOutput(): {
	append(chunk: Buffer | string): void;
	readonly text: string;
	readonly truncated: boolean;
} {
	const decoder = new StringDecoder("utf8");
	const chunks: string[] = [];
	let bytes = 0;
	let truncated = false;
	let finalized: string | undefined;
	return {
		append(chunk): void {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = MAX_CONTAINER_OUTPUT_BYTES - bytes;
			if (buffer.length > remaining) truncated = true;
			if (remaining <= 0) return;
			const kept = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
			const decoded = decoder.write(kept);
			if (decoded) chunks.push(decoded);
			bytes += kept.length;
		},
		get text(): string {
			if (finalized === undefined) {
				if (!truncated) {
					const tail = decoder.end();
					if (tail) chunks.push(tail);
				}
				finalized = chunks.join("");
			}
			return finalized;
		},
		get truncated(): boolean {
			return truncated;
		},
	};
}

/**
 * Hace spawn de `container` con un array argv. Falla de spawn, exit no cero, timeout o
 * abort vuelven como un ContainerResult (nunca lanza), igual que el runGit de pandi-worktree.
 */
export function runContainer(args: string[], options: RunContainerOptions = {}): Promise<ContainerResult> {
	const { cwd, signal, timeoutMs = DEFAULT_CONTAINER_TIMEOUT_MS, bin = "container" } = options;
	return new Promise((resolve) => {
		const stdout = createBoundedOutput();
		const stderr = createBoundedOutput();
		let settled = false;
		let termination: "timeout" | "abort" | undefined;
		let spawnError: string | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const useProcessGroup = process.platform !== "win32";

		const child = spawn(bin, args, { cwd, detached: useProcessGroup, windowsHide: true });

		const sendSignal = (processSignal: NodeJS.Signals): void => {
			if (useProcessGroup && child.pid && child.pid !== process.pid) {
				try {
					process.kill(-child.pid, processSignal);
					return;
				} catch {
					// El fallback conserva el comportamiento en hosts sin group kill.
				}
			}
			try {
				child.kill(processSignal);
			} catch {
				// El proceso ya cerró.
			}
		};

		const finish = (code: number | null, childSignal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({
				ok: !spawnError && !termination && code === 0,
				stdout: stdout.text,
				stderr: stderr.text,
				exitCode: spawnError ? undefined : (code ?? undefined),
				timedOut: termination === "timeout",
				aborted: termination === "abort",
				signal: childSignal ?? undefined,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				spawnError,
			});
		};

		const terminate = (reason: "timeout" | "abort"): void => {
			if (settled || termination) return;
			termination = reason;
			sendSignal("SIGTERM");
			killTimer = setTimeout(() => {
				if (!settled) sendSignal("SIGKILL");
			}, CONTAINER_TERMINATION_GRACE_MS);
			killTimer.unref?.();
		};

		const onAbort = (): void => terminate("abort");

		child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
		child.once("error", (err: Error) => {
			spawnError = err.message;
		});
		child.once("close", finish);

		timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
		timeoutTimer.unref?.();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

// --------------------------------------------------------------------------
// Plataforma + guardas de nombre
// --------------------------------------------------------------------------

/** Apple `container` requiere macOS en Apple Silicon. */
export function isSupportedPlatform(platform: string = process.platform, arch: string = process.arch): boolean {
	return platform === "darwin" && arch === "arm64";
}

const MACHINE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateMachineName(name: string): boolean {
	return typeof name === "string" && name.length > 0 && name.length <= 64 && MACHINE_NAME_RE.test(name);
}

// --------------------------------------------------------------------------
// Parseo + formateo
// --------------------------------------------------------------------------

export interface MachineEntry {
	id: string;
	status?: string;
	ipAddress?: string;
	cpus?: number;
	memory?: number;
	diskSize?: number;
	isDefault?: boolean;
	createdDate?: string;
}

function normalizeMachineRow(row: Record<string, unknown>): MachineEntry {
	return {
		id: String(row.id ?? ""),
		status: row.status != null ? String(row.status) : undefined,
		ipAddress: row.ipAddress != null ? String(row.ipAddress) : undefined,
		cpus: typeof row.cpus === "number" ? row.cpus : undefined,
		memory: typeof row.memory === "number" ? row.memory : undefined,
		diskSize: typeof row.diskSize === "number" ? row.diskSize : undefined,
		isDefault: row.default === true,
		createdDate: row.createdDate != null ? String(row.createdDate) : undefined,
	};
}

/** Parsea `container machine ls --format json`; entrada basura/inválida → []. */
export function parseMachineList(jsonText: string): MachineEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
		.map(normalizeMachineRow)
		.filter((m) => m.id.length > 0);
}

/** Humaniza una cantidad de bytes a un texto corto con unidades binarias (ej. 19327352832 → "18G"). */
export function humanBytes(bytes?: number): string {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "?";
	const units = ["B", "K", "M", "G", "T"];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i += 1;
	}
	const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded}${units[i]}`;
}

export function describeMachine(m: MachineEntry): string {
	const star = m.isDefault ? "* " : "  ";
	const bits = [
		m.status ?? "?",
		m.ipAddress ? `ip=${m.ipAddress}` : null,
		m.cpus != null ? `${m.cpus}cpu` : null,
		m.memory != null ? `mem=${humanBytes(m.memory)}` : null,
		m.diskSize != null ? `disk=${humanBytes(m.diskSize)}` : null,
	].filter(Boolean);
	return `${star}${m.id}  (${bits.join(", ")})`;
}

function renderMachineList(lines: string[]): string {
	return lines.join("\n");
}

export function formatMachineList(entries: MachineEntry[]): string {
	if (entries.length === 0) return "No hay máquinas de contenedor.";
	const lines = entries.map(describeMachine);
	return renderMachineList(lines);
}

// --------------------------------------------------------------------------
// Niveles de tamaño (presets con nombre de cpu/memory)
// --------------------------------------------------------------------------

/**
 * Presets de tamaño con nombre para micro-VMs sandbox. Son opt-in: cuando el caller no pasa ni
 * un tier ni cpus/memory explícitos, no se emiten flags y la CLI `container`
 * aplica sus propios defaults (a partir de v1.0.0: `machine create --memory` usa por defecto
 * la MITAD de la RAM del host; `--cpus` no está documentado) — enorme para un sandbox, justo
 * por eso existen estos presets. Los tiers aplican a `machine create` y a runs efímeros
 * por imagen nada más; los recursos de una máquina persistente quedan fijados en la creación upstream.
 *
 * Escalera: rebasada sobre un micro de 256M, duplicando la memoria por tier. El stack de virtualización
 * impone un mínimo duro de 200 MiB por VM, y un `npm i -g` + `pi
 * --version` real se verificó dentro de una VM de 200M con ~114MB de RSS, así que 256M
 * alcanza cómodamente para cargas chicas de Node/CLI.
 */
export const TIER_NAMES = ["micro", "tiny", "small", "medium", "large"] as const;

export type TierName = (typeof TIER_NAMES)[number];

export const TIER_PRESETS: Record<TierName, { cpus: number; memory: string }> = {
	micro: { cpus: 1, memory: "256M" },
	tiny: { cpus: 2, memory: "512M" },
	small: { cpus: 2, memory: "1G" },
	medium: { cpus: 4, memory: "2G" },
	large: { cpus: 8, memory: "4G" },
};

function isTierName(tier: string): tier is TierName {
	return (TIER_NAMES as readonly string[]).includes(tier);
}

/**
 * Tiers válidos para máquinas persistentes. La CLI exige un mínimo de 1G para
 * `machine create` (error real: "invalid memory value '256mb'. Must be greater
 * than 1gb"), mientras `run` efímero baja hasta 200 MiB — así que los tiers sub-1G
 * (micro/tiny) son solo para runs efímeros.
 */
export const MACHINE_TIER_NAMES = ["small", "medium", "large"] as const;

/** Lista humana de una línea con los tiers y sus tamaños (para errores + ayuda). */
export function describeTiers(names: readonly TierName[] = TIER_NAMES): string {
	return names.map((t) => `${t} (${TIER_PRESETS[t].cpus}cpu/${TIER_PRESETS[t].memory})`).join(", ");
}

export interface SizeResolution {
	ok: boolean;
	cpus?: number;
	memory?: string;
	error?: string;
}

/**
 * Resuelve un tier + cpus/memory explícitos a los tamaños finales (puro).
 * Los cpus/memory explícitos siempre ganan sobre el tier, campo por campo (menor sorpresa,
 * retrocompatible). Sin tier y sin tamaños explícitos → resolución vacía, así la
 * CLI sigue aplicando sus propios defaults exactamente igual que antes.
 */
export function resolveSize(opts: { tier?: string; cpus?: number; memory?: string }): SizeResolution {
	const { tier, cpus, memory } = opts;
	if (tier != null && tier !== "") {
		if (!isTierName(tier)) {
			return { ok: false, error: `Nivel de tamaño desconocido "${tier}". Niveles válidos: ${describeTiers()}.` };
		}
		const preset = TIER_PRESETS[tier];
		return { ok: true, cpus: cpus ?? preset.cpus, memory: memory ?? preset.memory };
	}
	return { ok: true, cpus, memory };
}

// --------------------------------------------------------------------------
// Constructores de argv (puros)
// --------------------------------------------------------------------------

export function buildStatusArgs(): string[] {
	return ["system", "status", "--format", "json"];
}

export function buildMachineListArgs(): string[] {
	return ["machine", "ls", "--format", "json"];
}

export interface CreateOptions {
	image: string;
	name?: string;
	/** Preset de tamaño con nombre; runCreate lo resuelve a cpus/memory (los valores explícitos ganan). */
	tier?: string;
	cpus?: number;
	memory?: string;
	homeMount?: "ro" | "rw" | "none";
	setDefault?: boolean;
}

export function buildMachineCreateArgs(opts: CreateOptions): string[] {
	const args = ["machine", "create"];
	if (opts.name) args.push("-n", opts.name);
	if (opts.setDefault) args.push("--set-default");
	if (opts.cpus != null) args.push("--cpus", String(opts.cpus));
	if (opts.memory) args.push("--memory", opts.memory);
	if (opts.homeMount) args.push("--home-mount", opts.homeMount);
	args.push(opts.image); // image es posicional y va AL FINAL
	return args;
}

export interface ExecMachineOptions {
	name?: string;
	workdir?: string;
	command: string[];
}

export function buildMachineExecArgs(opts: ExecMachineOptions): string[] {
	const args = ["machine", "run"];
	if (opts.name) args.push("-n", opts.name);
	if (opts.workdir) args.push("-w", opts.workdir);
	args.push("--", ...opts.command); // `--` separa el ejecutable+args
	return args;
}

export interface EphemeralRunOptions {
	image: string;
	workdir?: string;
	cpus?: number;
	memory?: string;
	command: string[];
}

export function buildEphemeralRunArgs(opts: EphemeralRunOptions): string[] {
	const args = ["run", "--rm"];
	if (opts.cpus != null) args.push("--cpus", String(opts.cpus));
	if (opts.memory) args.push("--memory", opts.memory);
	if (opts.workdir) args.push("-w", opts.workdir);
	args.push(opts.image, ...opts.command); // image es posicional ANTES de los args
	return args;
}

export function buildStopArgs(opts: { name?: string }): string[] {
	const args = ["machine", "stop"];
	if (opts.name) args.push(opts.name);
	return args;
}

export function buildRemoveArgs(opts: { name: string }): string[] {
	return ["machine", "delete", opts.name];
}

// --------------------------------------------------------------------------
// Normalización de errores
// --------------------------------------------------------------------------

const INSTALL_HINT = "No se encontró la CLI de Apple `container`. Instalala con: brew install container";

function outputTruncationDetails(result: ContainerResult): Record<string, true> {
	return {
		...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
		...(result.stderrTruncated ? { stderrTruncated: true } : {}),
	};
}

function describeOutputTruncation(result: ContainerResult): string | undefined {
	const streams = [
		result.stdoutTruncated ? "stdout" : undefined,
		result.stderrTruncated ? "stderr" : undefined,
	].filter((stream): stream is string => Boolean(stream));
	return streams.length
		? `La salida de ${streams.join(" y ")} fue truncada al límite de ${MAX_CONTAINER_OUTPUT_BYTES} bytes.`
		: undefined;
}

/** Convierte un ContainerResult fallido en una sola línea acotada y accionable. */
export function describeError(result: ContainerResult, action: string): string {
	const truncation = describeOutputTruncation(result);
	const withTruncation = (message: string): string => (truncation ? `${message} ${truncation}` : message);
	if (result.spawnError) {
		if (/ENOENT/i.test(result.spawnError)) return withTruncation(INSTALL_HINT);
		return withTruncation(`No se pudo ejecutar \`container ${action}\`: ${result.spawnError}`);
	}
	if (result.timedOut) return withTruncation(`\`container ${action}\` agotó el tiempo de espera.`);
	if (result.aborted) return withTruncation(`\`container ${action}\` fue abortado.`);
	if (result.signal) return withTruncation(`\`container ${action}\` terminó por señal ${result.signal}.`);
	const detail = (result.stderr || result.stdout || "").trim();
	return withTruncation(
		detail
			? `\`container ${action}\` falló: ${detail}`
			: `\`container ${action}\` falló (salida ${result.exitCode ?? "?"}).`,
	);
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

function handlerError(action: string, text: string, extraDetails: Record<string, unknown> = {}): HandlerResult {
	return {
		ok: false,
		text,
		details: { isError: true, action, ...extraDetails },
	};
}

function invalidMachineNameResult(name: unknown, action: string): HandlerResult {
	return handlerError(
		action,
		`Nombre de máquina inválido "${String(name)}": usá letras, dígitos, ".", "_", o "-", empezando con una letra o dígito (máx. 64 caracteres).`,
	);
}

export async function runStatus(run: RunContainer, opts: HandlerOpts): Promise<HandlerResult> {
	const status = await run(buildStatusArgs(), opts);
	if (!status.ok) {
		return handlerError("status", describeError(status, "system status"), outputTruncationDetails(status));
	}
	const statusTruncation = describeOutputTruncation(status);
	if (statusTruncation) {
		return handlerError("status", statusTruncation, outputTruncationDetails(status));
	}
	const list = await run(buildMachineListArgs(), opts);
	const listTruncation = describeOutputTruncation(list);
	if (listTruncation) {
		return handlerError("status", listTruncation, outputTruncationDetails(list));
	}
	const machines = list.ok ? parseMachineList(list.stdout) : [];
	const text = `Subsistema: en ejecución\n\nMáquinas:\n${formatMachineList(machines)}`;
	return { ok: true, text, details: { action: "status", running: true, machines } };
}

export async function runList(run: RunContainer, opts: HandlerOpts): Promise<HandlerResult> {
	const result = await run(buildMachineListArgs(), opts);
	if (!result.ok) {
		return handlerError("list", describeError(result, "machine ls"), outputTruncationDetails(result));
	}
	const truncation = describeOutputTruncation(result);
	if (truncation) {
		return handlerError("list", truncation, outputTruncationDetails(result));
	}
	const machines = parseMachineList(result.stdout);
	return {
		ok: true,
		text: formatMachineList(machines),
		details: { action: "list", count: machines.length, machines },
	};
}

export async function runCreate(run: RunContainer, params: CreateOptions, opts: HandlerOpts): Promise<HandlerResult> {
	if (!params.image) {
		return handlerError("create", "create requiere un 'image' (ej. alpine:latest).");
	}
	if (params.name && !validateMachineName(params.name)) {
		return invalidMachineNameResult(params.name, "create");
	}
	if (params.tier && isTierName(params.tier) && !(MACHINE_TIER_NAMES as readonly string[]).includes(params.tier)) {
		const machineTiers = describeTiers(MACHINE_TIER_NAMES);
		return handlerError(
			"create",
			`El nivel "${params.tier}" es demasiado chico para una máquina persistente — la CLI requiere al menos 1G de memoria para 'machine create'. Niveles de máquina: ${machineTiers}. Los niveles menores a 1G solo sirven para runs efímeros de imagen.`,
		);
	}
	const size = resolveSize({ tier: params.tier, cpus: params.cpus, memory: params.memory });
	if (!size.ok) {
		return handlerError("create", size.error ?? "Nivel de tamaño inválido.");
	}
	const result = await run(buildMachineCreateArgs({ ...params, cpus: size.cpus, memory: size.memory }), opts);
	if (!result.ok) {
		return handlerError("create", describeError(result, "machine create"));
	}
	const name = params.name ?? "(predeterminada)";
	return {
		ok: true,
		text: `Se creó la máquina de contenedor ${name} a partir de ${params.image}.`,
		details: { action: "create", name: params.name, image: params.image },
	};
}

export interface ExecParams {
	command: string[];
	machine?: string;
	image?: string;
	workdir?: string;
	/** Preset de tamaño con nombre; solo runs efímeros (image) — los recursos de la máquina quedan fijos al crearla. */
	tier?: string;
	cpus?: number;
	memory?: string;
}

function describeRunTarget(params: Pick<ExecParams, "machine" | "image">): string {
	return params.machine ? `máquina ${params.machine}` : `contenedor efímero ${params.image}`;
}

export async function runExec(run: RunContainer, params: ExecParams, opts: HandlerOpts): Promise<HandlerResult> {
	if (!Array.isArray(params.command) || params.command.length === 0) {
		return handlerError("run", "run requiere un array 'command' no vacío (argv).");
	}
	if (!params.machine && !params.image) {
		return handlerError("run", "run requiere 'machine' (existente) o 'image' (efímero).");
	}
	if (params.machine && !validateMachineName(params.machine)) {
		return invalidMachineNameResult(params.machine, "run");
	}
	if (params.machine && params.tier) {
		return handlerError(
			"run",
			`Los niveles de tamaño no aplican a un run dentro de la máquina existente "${params.machine}" — sus recursos quedan fijados en la creación. Usá un nivel en 'create' o en un run efímero de imagen.`,
		);
	}
	let args: string[];
	if (params.machine) {
		args = buildMachineExecArgs({ name: params.machine, workdir: params.workdir, command: params.command });
	} else {
		const size = resolveSize({ tier: params.tier, cpus: params.cpus, memory: params.memory });
		if (!size.ok) {
			return handlerError("run", size.error ?? "Nivel de tamaño inválido.");
		}
		args = buildEphemeralRunArgs({
			image: params.image as string,
			workdir: params.workdir,
			cpus: size.cpus,
			memory: size.memory,
			command: params.command,
		});
	}
	const result = await run(args, opts);
	const target = describeRunTarget(params);
	if (!result.ok) {
		return handlerError("run", describeError(result, "run"), {
			target,
			...outputTruncationDetails(result),
		});
	}
	const output = result.stdout.trim() || `(sin salida) — ejecutado en ${target}`;
	const truncation = describeOutputTruncation(result);
	const text = truncation ? `${output}\n\nAdvertencia: ${truncation}` : output;
	return {
		ok: true,
		text,
		details: { action: "run", target, exitCode: result.exitCode, ...outputTruncationDetails(result) },
	};
}

export async function runStop(run: RunContainer, params: { name?: string }, opts: HandlerOpts): Promise<HandlerResult> {
	if (params.name && !validateMachineName(params.name)) {
		return invalidMachineNameResult(params.name, "stop");
	}
	const result = await run(buildStopArgs(params), opts);
	if (!result.ok) {
		return handlerError("stop", describeError(result, "machine stop"));
	}
	return {
		ok: true,
		text: `Se detuvo la máquina de contenedor ${params.name ?? "(predeterminada)"}.`,
		details: { action: "stop", name: params.name },
	};
}

export async function runRemove(
	run: RunContainer,
	params: { name: string; force?: boolean },
	opts: HandlerOpts,
): Promise<HandlerResult> {
	if (!params.name || !validateMachineName(params.name)) {
		return invalidMachineNameResult(params.name, "remove");
	}
	if (!params.force) {
		return handlerError(
			"remove",
			`Me niego a eliminar la máquina "${params.name}" sin force. Pasá force:true (en la tool) o confirmá (en el comando).`,
			{ needsForce: true, name: params.name },
		);
	}
	const result = await run(buildRemoveArgs({ name: params.name }), opts);
	if (!result.ok) {
		return handlerError("remove", describeError(result, "machine delete"));
	}
	return {
		ok: true,
		text: `Se eliminó la máquina de contenedor ${params.name}.`,
		details: { action: "remove", name: params.name },
	};
}
