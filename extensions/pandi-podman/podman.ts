/**
 * Núcleo standalone de pandi-podman: spawn argv, parseo JSON y handlers puros.
 *
 * Podman nunca recibe una cadena de shell. Los handlers solo construyen el
 * subconjunto reducido de argv que publica la extensión, para que la tool no
 * se convierta en un passthrough de mounts, puertos o privilegios del host.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface PodmanResult {
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
	spawnError?: string;
}

export interface RunPodmanOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	bin?: string;
}

export const DEFAULT_PODMAN_TIMEOUT_MS = 120_000;
export const MIN_PODMAN_TIMEOUT_MS = 1_000;
const MAX_PODMAN_OUTPUT_BYTES = 1_000_000;
const PODMAN_TERMINATION_GRACE_MS = 250;
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY = "1G";
const DEFAULT_PIDS_LIMIT = 256;

export function parseTimeoutMs(raw: string | undefined, fallback = DEFAULT_PODMAN_TIMEOUT_MS): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(MIN_PODMAN_TIMEOUT_MS, Math.floor(value));
}

export type RunPodman = (args: string[], options?: RunPodmanOptions) => Promise<PodmanResult>;

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
			const remaining = MAX_PODMAN_OUTPUT_BYTES - bytes;
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

/** Ejecuta la CLI sin shell; errores del proceso vuelven como datos para la UI/tool. */
export function runPodman(args: string[], options: RunPodmanOptions = {}): Promise<PodmanResult> {
	const { cwd, signal, timeoutMs = DEFAULT_PODMAN_TIMEOUT_MS, bin = "podman" } = options;
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
			}, PODMAN_TERMINATION_GRACE_MS);
			killTimer.unref?.();
		};

		const onAbort = (): void => terminate("abort");

		child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
		child.once("error", (error: Error) => {
			spawnError = error.message;
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

const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function validateContainerName(name: string): boolean {
	return typeof name === "string" && CONTAINER_NAME_RE.test(name);
}

/** Acepta referencias OCI generales, pero nunca valores que Podman pueda interpretar como flags. */
export function validateImageReference(image: string): boolean {
	return typeof image === "string" && image.length > 0 && image.length <= 512 && /^[^\s-][^\s]*$/.test(image);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

export interface ContainerEntry {
	id: string;
	name?: string;
	image?: string;
	state?: string;
	status?: string;
	createdAt?: string;
}

export function parseContainerList(jsonText: string): ContainerEntry[] {
	try {
		const parsed: unknown = JSON.parse(jsonText);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((value) => record(value))
			.filter((value): value is Record<string, unknown> => Boolean(value))
			.map((row) => {
				const names = Array.isArray(row.Names) ? row.Names : [];
				return {
					id: text(row.Id) ?? text(row.ID) ?? text(row.id) ?? "",
					name: text(names[0]) ?? text(row.Name) ?? text(row.Names),
					image: text(row.Image) ?? text(row.image),
					state: text(row.State) ?? text(row.state),
					status: text(row.Status) ?? text(row.status),
					createdAt: text(row.CreatedAt) ?? text(row.createdAt),
				};
			})
			.filter((entry) => entry.id.length > 0);
	} catch {
		return [];
	}
}

export function formatContainerList(entries: ContainerEntry[]): string {
	if (entries.length === 0) return "No hay contenedores de Podman.";
	return entries
		.map((entry) => `  ${entry.name ?? entry.id.slice(0, 12)}  (${entry.state ?? "?"}, ${entry.image ?? "imagen ?"})`)
		.join("\n");
}

export interface MachineEntry {
	name: string;
	isDefault?: boolean;
	running?: boolean;
	cpus?: number;
	memory?: number;
	diskSize?: number;
	vmType?: string;
}

export function parseMachineList(jsonText: string): MachineEntry[] {
	try {
		const parsed: unknown = JSON.parse(jsonText);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((value) => record(value))
			.filter((value): value is Record<string, unknown> => Boolean(value))
			.map((row) => ({
				name: text(row.Name) ?? text(row.name) ?? "",
				isDefault: row.Default === true || row.default === true,
				running: row.Running === true || row.running === true,
				cpus: number(row.CPUs) ?? number(row.cpus),
				memory: number(row.Memory) ?? number(row.memory),
				diskSize: number(row.DiskSize) ?? number(row.diskSize),
				vmType: text(row.VMType) ?? text(row.vmType),
			}))
			.filter((entry) => entry.name.length > 0);
	} catch {
		return [];
	}
}

function humanBytes(bytes: number | undefined): string {
	if (bytes == null || bytes < 0) return "?";
	const units = ["B", "K", "M", "G", "T"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded}${units[unit]}`;
}

export function formatMachineList(entries: MachineEntry[]): string {
	if (entries.length === 0) return "No hay máquinas de Podman.";
	return entries
		.map((entry) => {
			const defaultMark = entry.isDefault ? "* " : "  ";
			const bits = [
				entry.running ? "running" : "stopped",
				entry.vmType,
				entry.cpus && `${entry.cpus}cpu`,
				entry.memory && `mem=${humanBytes(entry.memory)}`,
			]
				.filter(Boolean)
				.join(", ");
			return `${defaultMark}${entry.name}  (${bits})`;
		})
		.join("\n");
}

export interface PodmanInfo {
	version?: string;
	rootless?: boolean;
	containers?: number;
	images?: number;
}

export function parseInfo(jsonText: string): PodmanInfo {
	try {
		const parsed = record(JSON.parse(jsonText));
		const host = record(parsed?.host);
		const security = record(host?.security);
		const store = record(parsed?.store);
		const containers = record(store?.containerStore);
		const images = record(store?.imageStore);
		const version = record(parsed?.version);
		return {
			version: text(version?.Version) ?? text(version?.version),
			rootless: security?.rootless === true,
			containers: number(containers?.number),
			images: number(images?.number),
		};
	} catch {
		return {};
	}
}

// Constructores de argv: toda la política de superficie permitida queda visible y testeable acá.
export function buildInfoArgs(): string[] {
	return ["info", "--format", "json"];
}

export function buildListArgs(): string[] {
	return ["ps", "--all", "--format", "json"];
}

export function buildMachineListArgs(): string[] {
	return ["machine", "list", "--format", "json"];
}

export function buildMachineStartArgs(name?: string): string[] {
	return name ? ["machine", "start", name] : ["machine", "start"];
}

export function buildStopArgs(name: string): string[] {
	return ["stop", name];
}

export function buildRemoveArgs(name: string): string[] {
	return ["rm", "--force", name];
}

export interface SandboxParams {
	image: string;
	command: string[];
	network?: "none" | "default";
	workdir?: string;
	cpus?: number;
	memory?: string;
}

export function buildRunArgs(params: SandboxParams): string[] {
	return [
		"run",
		"--rm",
		"--network",
		params.network ?? "none",
		// Podman propaga proxy del host por defecto; desactivarlo preserva el contrato sin env del host.
		"--http-proxy=false",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		String(DEFAULT_PIDS_LIMIT),
		"--read-only",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,noexec",
		"--cpus",
		String(params.cpus ?? DEFAULT_CPUS),
		"--memory",
		params.memory ?? DEFAULT_MEMORY,
		...(params.workdir ? ["--workdir", params.workdir] : []),
		params.image,
		...params.command,
	];
}

const INSTALL_HINT =
	process.platform === "darwin"
		? "No se encontró Podman. Instalalo con: brew install podman"
		: "No se encontró Podman. Instalalo con el gestor de paquetes de tu sistema.";

function outputTruncationDetails(result: PodmanResult): Record<string, true> {
	return {
		...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
		...(result.stderrTruncated ? { stderrTruncated: true } : {}),
	};
}

function describeOutputTruncation(result: PodmanResult): string | undefined {
	const streams = [
		result.stdoutTruncated ? "stdout" : undefined,
		result.stderrTruncated ? "stderr" : undefined,
	].filter((stream): stream is string => Boolean(stream));
	return streams.length
		? `La salida de ${streams.join(" y ")} fue truncada al límite de ${MAX_PODMAN_OUTPUT_BYTES} bytes.`
		: undefined;
}

export function describePodmanError(result: PodmanResult, action: string): string {
	const truncation = describeOutputTruncation(result);
	const withTruncation = (message: string): string => (truncation ? `${message} ${truncation}` : message);
	if (result.spawnError)
		return /ENOENT/i.test(result.spawnError)
			? withTruncation(INSTALL_HINT)
			: withTruncation(`No se pudo ejecutar \`podman ${action}\`: ${result.spawnError}`);
	if (result.timedOut) return withTruncation(`\`podman ${action}\` agotó el tiempo de espera.`);
	if (result.aborted) return withTruncation(`\`podman ${action}\` fue abortado.`);
	if (result.signal) return withTruncation(`\`podman ${action}\` terminó por señal ${result.signal}.`);
	const detail = (result.stderr || result.stdout).trim();
	return withTruncation(
		detail
			? `\`podman ${action}\` falló: ${detail}`
			: `\`podman ${action}\` falló (salida ${result.exitCode ?? "?"}).`,
	);
}

export interface HandlerResult {
	ok: boolean;
	text: string;
	details: Record<string, unknown>;
}

export interface HandlerOpts {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	platform?: NodeJS.Platform;
}

function handlerError(action: string, text: string, details: Record<string, unknown> = {}): HandlerResult {
	return { ok: false, text, details: { isError: true, action, ...details } };
}

function isMachinePlatform(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin" || platform === "win32";
}

function validWorkdir(workdir: string | undefined): boolean {
	return workdir == null || (workdir.startsWith("/") && !workdir.includes("\0"));
}

function memoryBytes(memory: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([KMG])$/i.exec(memory);
	if (!match) return undefined;
	const units = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as const;
	return Number(match[1]) * units[match[2].toUpperCase() as keyof typeof units];
}

function validateSandbox(params: SandboxParams): string | undefined {
	if (!validateImageReference(params.image))
		return "run requiere una referencia de image válida, sin espacios ni flags.";
	if (
		!Array.isArray(params.command) ||
		params.command.length === 0 ||
		params.command.some((arg) => typeof arg !== "string")
	)
		return "run requiere un array command no vacío (argv).";
	if (params.network != null && params.network !== "none" && params.network !== "default")
		return "network solo puede ser 'none' (predeterminado) o 'default' (opt-in).";
	if (!validWorkdir(params.workdir)) return "workdir debe ser una ruta absoluta dentro del contenedor.";
	if (params.cpus != null && (!Number.isFinite(params.cpus) || params.cpus <= 0 || params.cpus > DEFAULT_CPUS))
		return `cpus debe estar entre 0 y ${DEFAULT_CPUS}; solo se permiten límites iguales o más estrictos.`;
	if (params.memory != null) {
		const bytes = memoryBytes(params.memory);
		if (bytes == null || bytes < 16 * 1024 ** 2 || bytes > 1024 ** 3)
			return "memory debe estar entre 16M y 1G; solo se permiten límites iguales o más estrictos.";
	}
	return undefined;
}

export async function runStatus(run: RunPodman, opts: HandlerOpts): Promise<HandlerResult> {
	const infoResult = await run(buildInfoArgs(), opts);
	const infoTruncation = describeOutputTruncation(infoResult);
	if (!infoResult.ok) {
		if (infoTruncation)
			return handlerError("status", describePodmanError(infoResult, "info"), outputTruncationDetails(infoResult));
		if (!isMachinePlatform(opts.platform))
			return handlerError("status", describePodmanError(infoResult, "info"), outputTruncationDetails(infoResult));
		const machinesResult = await run(buildMachineListArgs(), opts);
		const machinesTruncation = describeOutputTruncation(machinesResult);
		if (machinesTruncation)
			return handlerError(
				"status",
				machinesResult.ok ? machinesTruncation : describePodmanError(machinesResult, "machine list"),
				outputTruncationDetails(machinesResult),
			);
		if (!machinesResult.ok)
			return handlerError(
				"status",
				describePodmanError(machinesResult, "machine list"),
				outputTruncationDetails(machinesResult),
			);
		const machines = parseMachineList(machinesResult.stdout);
		return handlerError(
			"status",
			`Podman no está disponible. Revisá las máquinas:\n${formatMachineList(machines)}\n\nIniciá una con: /podman machine-start [name]`,
			{ machines },
		);
	}
	if (infoTruncation) return handlerError("status", infoTruncation, outputTruncationDetails(infoResult));
	const info = parseInfo(infoResult.stdout);
	let machines: MachineEntry[] | undefined;
	if (isMachinePlatform(opts.platform)) {
		const machinesResult = await run(buildMachineListArgs(), opts);
		const machinesTruncation = describeOutputTruncation(machinesResult);
		if (machinesTruncation)
			return handlerError(
				"status",
				machinesResult.ok ? machinesTruncation : describePodmanError(machinesResult, "machine list"),
				outputTruncationDetails(machinesResult),
			);
		if (!machinesResult.ok)
			return handlerError(
				"status",
				describePodmanError(machinesResult, "machine list"),
				outputTruncationDetails(machinesResult),
			);
		machines = parseMachineList(machinesResult.stdout);
	}
	const summary = [
		`Podman ${info.version ?? "(versión desconocida)"}${info.rootless === true ? " · rootless" : ""}`,
		info.containers != null ? `Contenedores: ${info.containers}` : null,
		info.images != null ? `Imágenes: ${info.images}` : null,
		machines ? `\nMáquinas:\n${formatMachineList(machines)}` : null,
	]
		.filter(Boolean)
		.join("\n");
	return { ok: true, text: summary, details: { action: "status", info, ...(machines ? { machines } : {}) } };
}

export async function runList(run: RunPodman, opts: HandlerOpts): Promise<HandlerResult> {
	const result = await run(buildListArgs(), opts);
	if (!result.ok) return handlerError("list", describePodmanError(result, "ps"), outputTruncationDetails(result));
	const truncation = describeOutputTruncation(result);
	if (truncation) return handlerError("list", truncation, outputTruncationDetails(result));
	const containers = parseContainerList(result.stdout);
	return {
		ok: true,
		text: formatContainerList(containers),
		details: { action: "list", count: containers.length, containers },
	};
}

export async function runSandbox(run: RunPodman, params: SandboxParams, opts: HandlerOpts): Promise<HandlerResult> {
	const error = validateSandbox(params);
	if (error) return handlerError("run", error);
	const result = await run(buildRunArgs(params), opts);
	if (!result.ok) return handlerError("run", describePodmanError(result, "run"), outputTruncationDetails(result));
	const output = result.stdout.trim() || "(sin salida) — sandbox efímero finalizado.";
	const truncation = describeOutputTruncation(result);
	return {
		ok: true,
		text: truncation ? `${output}\n\nAdvertencia: ${truncation}` : output,
		details: {
			action: "run",
			image: params.image,
			exitCode: result.exitCode,
			...outputTruncationDetails(result),
		},
	};
}

export async function runStop(run: RunPodman, params: { name?: string }, opts: HandlerOpts): Promise<HandlerResult> {
	if (!params.name || !validateContainerName(params.name))
		return handlerError("stop", "stop requiere un nombre de contenedor válido.");
	const result = await run(buildStopArgs(params.name), opts);
	if (!result.ok) return handlerError("stop", describePodmanError(result, "stop"));
	return { ok: true, text: `Se detuvo el contenedor ${params.name}.`, details: { action: "stop", name: params.name } };
}

export async function runRemove(
	run: RunPodman,
	params: { name?: string; force?: boolean },
	opts: HandlerOpts,
): Promise<HandlerResult> {
	if (!params.name || !validateContainerName(params.name))
		return handlerError("remove", "remove requiere un nombre de contenedor válido.");
	if (!params.force)
		return handlerError("remove", `Me niego a eliminar el contenedor "${params.name}" sin force.`, {
			needsForce: true,
			name: params.name,
		});
	const result = await run(buildRemoveArgs(params.name), opts);
	if (!result.ok) return handlerError("remove", describePodmanError(result, "rm"));
	return {
		ok: true,
		text: `Se eliminó el contenedor ${params.name}.`,
		details: { action: "remove", name: params.name },
	};
}

export async function runMachineList(run: RunPodman, opts: HandlerOpts): Promise<HandlerResult> {
	const result = await run(buildMachineListArgs(), opts);
	if (!result.ok)
		return handlerError("machine-list", describePodmanError(result, "machine list"), outputTruncationDetails(result));
	const truncation = describeOutputTruncation(result);
	if (truncation) return handlerError("machine-list", truncation, outputTruncationDetails(result));
	const machines = parseMachineList(result.stdout);
	return {
		ok: true,
		text: formatMachineList(machines),
		details: { action: "machine-list", count: machines.length, machines },
	};
}

export async function runMachineStart(
	run: RunPodman,
	params: { name?: string },
	opts: HandlerOpts,
): Promise<HandlerResult> {
	if (params.name && !validateContainerName(params.name))
		return handlerError("machine-start", "Nombre de máquina inválido.");
	const result = await run(buildMachineStartArgs(params.name), opts);
	if (!result.ok) return handlerError("machine-start", describePodmanError(result, "machine start"));
	return {
		ok: true,
		text: `Se inició la máquina de Podman ${params.name ?? "predeterminada"}.`,
		details: { action: "machine-start", name: params.name },
	};
}
