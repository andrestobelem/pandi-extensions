/**
 * Pure helpers + a single spawn seam for the pandi-container extension.
 *
 * Apple's `container` CLI runs Linux in lightweight micro-VMs (Virtualization.framework)
 * on Apple Silicon. This module wraps it the same way pandi-worktree wraps git:
 *   - `runContainer` spawns `container` with an ARGV array (never a shell string),
 *     so image refs / machine names / commands cannot inject shell.
 *   - `build*Args` are pure argv constructors (unit-tested exactly).
 *   - `parseMachineList` / `formatMachineList` parse the CLI's `--format json`.
 *   - `run*` handlers take an injected `run` fn so dispatch + the destructive-action
 *     gate are deterministic in tests without booting a real VM.
 */

import { spawn } from "node:child_process";

// --------------------------------------------------------------------------
// Spawn seam
// --------------------------------------------------------------------------

export interface ContainerResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode?: number;
	/** set when the process was killed by timeout/abort. */
	timedOut?: boolean;
	/** set when we never managed to spawn `container` at all (e.g. not installed). */
	spawnError?: string;
}

export interface RunContainerOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** binary to spawn; overridable so tests can point at a guaranteed-absent name. */
	bin?: string;
}

export const DEFAULT_CONTAINER_TIMEOUT_MS = 120_000;

/** Signature shared by runContainer and the injected fake runner in tests. */
export type RunContainer = (args: string[], options?: RunContainerOptions) => Promise<ContainerResult>;

/**
 * Spawn `container` with an argv array. Spawn failure, non-zero exit, timeout, or
 * abort all come back as a ContainerResult (never throws), mirroring pandi-worktree's runGit.
 */
export function runContainer(args: string[], options: RunContainerOptions = {}): Promise<ContainerResult> {
	const { cwd, signal, timeoutMs = DEFAULT_CONTAINER_TIMEOUT_MS, bin = "container" } = options;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const child = spawn(bin, args, { cwd, windowsHide: true });

		const finish = (result: ContainerResult) => {
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
// Platform + name guards
// --------------------------------------------------------------------------

/** Apple `container` requires macOS on Apple Silicon. */
export function isSupportedPlatform(platform: string = process.platform, arch: string = process.arch): boolean {
	return platform === "darwin" && arch === "arm64";
}

const MACHINE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateMachineName(name: string): boolean {
	return typeof name === "string" && name.length > 0 && name.length <= 64 && MACHINE_NAME_RE.test(name);
}

// --------------------------------------------------------------------------
// Parsing + formatting
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

/** Parse `container machine ls --format json`; junk/invalid input → []. */
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
		.map((row) => ({
			id: String(row.id ?? ""),
			status: row.status != null ? String(row.status) : undefined,
			ipAddress: row.ipAddress != null ? String(row.ipAddress) : undefined,
			cpus: typeof row.cpus === "number" ? row.cpus : undefined,
			memory: typeof row.memory === "number" ? row.memory : undefined,
			diskSize: typeof row.diskSize === "number" ? row.diskSize : undefined,
			isDefault: row.default === true,
			createdDate: row.createdDate != null ? String(row.createdDate) : undefined,
		}))
		.filter((m) => m.id.length > 0);
}

/** Humanize a byte count to a short binary-unit string (e.g. 19327352832 → "18G"). */
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

export function formatMachineList(entries: MachineEntry[]): string {
	if (entries.length === 0) return "No hay máquinas de contenedor.";
	return entries.map(describeMachine).join("\n");
}

// --------------------------------------------------------------------------
// Size tiers (named cpu/memory presets)
// --------------------------------------------------------------------------

/**
 * Named size presets for sandbox micro-VMs. Opt-in: when the caller passes neither
 * a tier nor explicit cpus/memory, no flags are emitted and the `container` CLI
 * applies its own defaults (as of v1.0.0: `machine create --memory` defaults to
 * HALF of the host's RAM, `--cpus` is undocumented) — huge for a sandbox, which is
 * exactly why these presets exist. Tiers apply to `machine create` and ephemeral
 * image runs only; a persistent machine's resources are fixed at creation upstream.
 *
 * Ladder: rebased on a 256M micro, doubling memory per tier. The virtualization
 * stack enforces a hard 200 MiB minimum per VM, and a real `npm i -g` + `pi
 * --version` was verified inside a 200M VM at ~114MB RSS, so 256M comfortably
 * runs small Node/CLI workloads.
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
 * Tiers valid for PERSISTENT machines. The CLI enforces a 1G minimum for
 * `machine create` (real error: "invalid memory value '256mb'. Must be greater
 * than 1gb"), while ephemeral `run` bottoms out at 200 MiB — so the sub-1G tiers
 * (micro/tiny) are ephemeral-run-only.
 */
export const MACHINE_TIER_NAMES = ["small", "medium", "large"] as const;

/** One-line human list of tiers with their sizes (for errors + help). */
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
 * Resolve a tier + explicit cpus/memory into the final sizes (pure).
 * Explicit cpus/memory always win over the tier, field by field (least surprise,
 * backward compatible). No tier and no explicit sizes → empty resolution, so the
 * CLI keeps applying its own defaults exactly as before.
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
// Argv builders (pure)
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
	/** Named size preset; resolved to cpus/memory in runCreate (explicit values win). */
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
	args.push(opts.image); // image is positional and LAST
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
	args.push("--", ...opts.command); // `--` separates the executable+args
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
	args.push(opts.image, ...opts.command); // image is positional BEFORE args
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
// Error normalization
// --------------------------------------------------------------------------

const INSTALL_HINT = "No se encontró la CLI de Apple `container`. Instalala con: brew install container";

/** Turn a failed ContainerResult into a single bounded, actionable line. */
export function describeError(result: ContainerResult, action: string): string {
	if (result.spawnError) {
		if (/ENOENT/i.test(result.spawnError)) return INSTALL_HINT;
		return `No se pudo ejecutar \`container ${action}\`: ${result.spawnError}`;
	}
	if (result.timedOut) return `\`container ${action}\` agotó el tiempo de espera.`;
	const detail = (result.stderr || result.stdout || "").trim();
	return detail
		? `\`container ${action}\` falló: ${detail}`
		: `\`container ${action}\` falló (salida ${result.exitCode ?? "?"}).`;
}

// --------------------------------------------------------------------------
// High-level action handlers (take an injected runner; pure dispatch otherwise)
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

export async function runStatus(run: RunContainer, opts: HandlerOpts): Promise<HandlerResult> {
	const status = await run(buildStatusArgs(), opts);
	if (!status.ok) {
		return { ok: false, text: describeError(status, "system status"), details: { isError: true, action: "status" } };
	}
	const list = await run(buildMachineListArgs(), opts);
	const machines = list.ok ? parseMachineList(list.stdout) : [];
	const text = `Subsistema: en ejecución\n\nMáquinas:\n${formatMachineList(machines)}`;
	return { ok: true, text, details: { action: "status", running: true, machines } };
}

export async function runList(run: RunContainer, opts: HandlerOpts): Promise<HandlerResult> {
	const result = await run(buildMachineListArgs(), opts);
	if (!result.ok) {
		return { ok: false, text: describeError(result, "machine ls"), details: { isError: true, action: "list" } };
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
		return {
			ok: false,
			text: "create requiere un 'image' (ej. alpine:latest).",
			details: { isError: true, action: "create" },
		};
	}
	if (params.name && !validateMachineName(params.name)) {
		return {
			ok: false,
			text: `Nombre de máquina inválido "${params.name}": usá letras, dígitos, ".", "_", o "-", empezando con una letra o dígito (máx. 64 caracteres).`,
			details: { isError: true, action: "create" },
		};
	}
	if (params.tier && isTierName(params.tier) && !(MACHINE_TIER_NAMES as readonly string[]).includes(params.tier)) {
		const machineTiers = describeTiers(MACHINE_TIER_NAMES);
		return {
			ok: false,
			text: `El nivel "${params.tier}" es demasiado chico para una máquina persistente — la CLI requiere al menos 1G de memoria para 'machine create'. Niveles de máquina: ${machineTiers}. Los niveles menores a 1G solo sirven para runs efímeros de imagen.`,
			details: { isError: true, action: "create" },
		};
	}
	const size = resolveSize({ tier: params.tier, cpus: params.cpus, memory: params.memory });
	if (!size.ok) {
		return {
			ok: false,
			text: size.error ?? "Nivel de tamaño inválido.",
			details: { isError: true, action: "create" },
		};
	}
	const result = await run(buildMachineCreateArgs({ ...params, cpus: size.cpus, memory: size.memory }), opts);
	if (!result.ok) {
		return { ok: false, text: describeError(result, "machine create"), details: { isError: true, action: "create" } };
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
	/** Named size preset; ephemeral (image) runs only — machine resources are fixed at creation. */
	tier?: string;
	cpus?: number;
	memory?: string;
}

export async function runExec(run: RunContainer, params: ExecParams, opts: HandlerOpts): Promise<HandlerResult> {
	if (!Array.isArray(params.command) || params.command.length === 0) {
		return {
			ok: false,
			text: "run requiere un array 'command' no vacío (argv).",
			details: { isError: true, action: "run" },
		};
	}
	if (!params.machine && !params.image) {
		return {
			ok: false,
			text: "run requiere 'machine' (existente) o 'image' (efímero).",
			details: { isError: true, action: "run" },
		};
	}
	if (params.machine && !validateMachineName(params.machine)) {
		return {
			ok: false,
			text: `Nombre de máquina inválido "${params.machine}": usá letras, dígitos, ".", "_", o "-", empezando con una letra o dígito (máx. 64 caracteres).`,
			details: { isError: true, action: "run" },
		};
	}
	if (params.machine && params.tier) {
		return {
			ok: false,
			text: `Los niveles de tamaño no aplican a un run dentro de la máquina existente "${params.machine}" — sus recursos quedan fijados en la creación. Usá un nivel en 'create' o en un run efímero de imagen.`,
			details: { isError: true, action: "run" },
		};
	}
	let args: string[];
	if (params.machine) {
		args = buildMachineExecArgs({ name: params.machine, workdir: params.workdir, command: params.command });
	} else {
		const size = resolveSize({ tier: params.tier, cpus: params.cpus, memory: params.memory });
		if (!size.ok) {
			return {
				ok: false,
				text: size.error ?? "Nivel de tamaño inválido.",
				details: { isError: true, action: "run" },
			};
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
	const target = params.machine ? `machine ${params.machine}` : `ephemeral ${params.image}`;
	if (!result.ok) {
		return { ok: false, text: describeError(result, "run"), details: { isError: true, action: "run", target } };
	}
	const text = result.stdout.trim() || `(sin salida) — ejecutado en ${target}`;
	return { ok: true, text, details: { action: "run", target, exitCode: result.exitCode } };
}

export async function runStop(run: RunContainer, params: { name?: string }, opts: HandlerOpts): Promise<HandlerResult> {
	if (params.name && !validateMachineName(params.name)) {
		return {
			ok: false,
			text: `Nombre de máquina inválido "${params.name}": usá letras, dígitos, ".", "_", o "-", empezando con una letra o dígito (máx. 64 caracteres).`,
			details: { isError: true, action: "stop" },
		};
	}
	const result = await run(buildStopArgs(params), opts);
	if (!result.ok) {
		return { ok: false, text: describeError(result, "machine stop"), details: { isError: true, action: "stop" } };
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
		return {
			ok: false,
			text: `Nombre de máquina inválido "${params.name}": usá letras, dígitos, ".", "_", o "-", empezando con una letra o dígito (máx. 64 caracteres).`,
			details: { isError: true, action: "remove" },
		};
	}
	if (!params.force) {
		return {
			ok: false,
			text: `Me niego a eliminar la máquina "${params.name}" sin force. Pasá force:true (en la tool) o confirmá (en el comando).`,
			details: { isError: true, action: "remove", needsForce: true, name: params.name },
		};
	}
	const result = await run(buildRemoveArgs({ name: params.name }), opts);
	if (!result.ok) {
		return { ok: false, text: describeError(result, "machine delete"), details: { isError: true, action: "remove" } };
	}
	return {
		ok: true,
		text: `Se eliminó la máquina de contenedor ${params.name}.`,
		details: { action: "remove", name: params.name },
	};
}
