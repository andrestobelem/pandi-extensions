/**
 * pandi-container: gestiona sandboxes de Apple `container` (micro-VMs Linux) desde Pi.
 *
 * Dos superficies (convención del proyecto; ver pandi-worktree):
 *   - `/container`           comando slash para humanos (interactivo, confirma ops destructivas)
 *   - `container_sandbox`    tool invocable por el modelo (acciones explícitas, sin borrados sorpresa)
 *
 * Ambos comparten las utilidades puras + manejadores de ./container.ts. `container` siempre se
 * invoca con un array ARGV (nunca un string de shell), así referencias de imagen / nombres de máquina /
 * comandos no pueden inyectar shell.
 *
 * Apple `container` corre cada entorno Linux en su propia VM liviana
 * (Virtualization.framework) y requiere macOS en Apple Silicon, la CLI `container`
 * (`brew install container`), un kernel configurado y un subsistema iniciado.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	describeTiers,
	type HandlerResult,
	isSupportedPlatform,
	runContainer,
	runCreate,
	runExec,
	runList,
	runRemove,
	runStatus,
	runStop,
	TIER_NAMES,
} from "./container.js";
import { notify } from "./notify.js";

// Reexportado para que la suite de integración pueda probar unitariamente las utilidades puras + manejadores
// directamente contra el mismo bundle generado.
export {
	buildEphemeralRunArgs,
	buildMachineCreateArgs,
	buildMachineExecArgs,
	buildMachineListArgs,
	buildRemoveArgs,
	buildStatusArgs,
	buildStopArgs,
	describeMachine,
	describeTiers,
	formatMachineList,
	humanBytes,
	isSupportedPlatform,
	MACHINE_TIER_NAMES,
	parseMachineList,
	resolveSize,
	runContainer,
	runCreate,
	runExec,
	runList,
	runRemove,
	runStatus,
	runStop,
	TIER_NAMES,
	TIER_PRESETS,
	validateMachineName,
} from "./container.js";

const CONTAINER_ACTIONS = [
	{ value: "status", selectLabel: "status — resumen del subsistema y las máquinas" },
	{ value: "list", selectLabel: "list — lista las máquinas del contenedor" },
	{ value: "create", selectLabel: "create — crea una máquina a partir de una imagen OCI" },
	{ value: "run", selectLabel: "run — ejecuta un comando en una máquina o en un contenedor efímero" },
	{ value: "stop", selectLabel: "stop — detiene una máquina" },
	{ value: "remove", selectLabel: "remove — elimina una máquina (pide confirmación)" },
] as const;

const SUBCOMMANDS = CONTAINER_ACTIONS.map(({ value }) => value);

const HELP_TEXT = [
	"Uso:",
	"  /container [status]                         resumen del subsistema y las máquinas",
	"  /container list                            lista las máquinas del contenedor",
	"  /container create <image> [name] [--size <tier>]   crea una máquina (ej. alpine:latest dev --size small)",
	"  /container run <machine> -- <cmd...>       ejecuta un comando dentro de una máquina",
	"  /container stop [name]                     detiene una máquina (la default si se omite)",
	"  /container remove <name>                   elimina una máquina (pide confirmación)",
	"",
	`Niveles de tamaño: ${describeTiers()}.`,
	"Sin un tamaño, la CLI usa por defecto la MITAD de la RAM del host (v1.0.0).",
	"Las máquinas necesitan >= 1G (piso de la CLI); micro/tiny solo aplican a runs efímeros.",
	"",
	"Apple `container` necesita macOS en Apple Silicon, `brew install container`, un",
	"kernel configurado (`container system kernel set --recommended`), y un subsistema",
	"iniciado (`container system start`).",
].join("\n");

const PLATFORM_MSG = "Apple `container` requiere macOS en Apple Silicon (arm64); este host no es compatible.";

/** Opciones con etiqueta humana para el selector de acciones de `/container` sin args (el primer token es el valor). */
export const CONTAINER_SELECT_ITEMS = CONTAINER_ACTIONS.map(({ selectLabel }) => selectLabel);

/**
 * Resuelve el argumento de `/container`, abriendo un selector interactivo de acciones cuando el
 * comando se invoca sin args en una sesión con UI. Sin UI (headless) y los args explícitos
 * mantienen el comportamiento intacto, así nada se rompe fuera del TUI. Cancelar devuelve "",
 * que `runCommand` renderiza como texto de ayuda.
 */
export async function resolveContainerInput(input: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Container action", CONTAINER_SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}

// --------------------------------------------------------------------------
// Parseo del comando (chico, local — sin imports de runtime compartidos)
// --------------------------------------------------------------------------

/**
 * Extrae una flag `--size <tier>` (alias `--tier <tier>`) de una lista de tokens (puro).
 * Devuelve los tokens restantes más el tier; una flag colgando produce un error acotado.
 */
export function parseSizeFlag(tokens: string[]): { tokens: string[]; tier?: string; error?: string } {
	const out: string[] = [];
	let tier: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--size" || token === "--tier") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("--")) {
				return { tokens: out, error: `--size requiere un nombre de nivel. Niveles válidos: ${describeTiers()}.` };
			}
			tier = next;
			i += 1;
		} else {
			out.push(token);
		}
	}
	return tier != null ? { tokens: out, tier } : { tokens: out };
}

/** Divide una línea de comando en subcomando y resto, respetando un separador argv `--`. */
export function parseContainerCommand(input: string): {
	action: string;
	rest: string[];
	command: string[];
} {
	const trimmed = (input ?? "").trim();
	const sepIndex = trimmed.indexOf(" -- ");
	const head = sepIndex >= 0 ? trimmed.slice(0, sepIndex) : trimmed;
	const command =
		sepIndex >= 0
			? trimmed
					.slice(sepIndex + 4)
					.trim()
					.split(/\s+/)
					.filter(Boolean)
			: [];
	const tokens = head.split(/\s+/).filter(Boolean);
	const action = (tokens.shift() ?? "status").toLowerCase();
	return { action, rest: tokens, command };
}

// --------------------------------------------------------------------------
// Handler del comando
// --------------------------------------------------------------------------

async function runCommand(ctx: ExtensionContext, input: string): Promise<void> {
	if (!isSupportedPlatform()) {
		notify(ctx, PLATFORM_MSG, "error");
		return;
	}
	const { action, rest, command } = parseContainerCommand(await resolveContainerInput(input, ctx));
	const opts = { cwd: ctx.cwd, signal: ctx.signal ?? undefined };

	if (action === "help" || action === "-h" || action === "--help") {
		notify(ctx, HELP_TEXT, "info");
		return;
	}

	let result: HandlerResult;
	switch (action) {
		case "status":
			result = await runStatus(runContainer, opts);
			break;
		case "list":
		case "ls":
			result = await runList(runContainer, opts);
			break;
		case "create": {
			const parsed = parseSizeFlag(rest);
			if (parsed.error) {
				notify(ctx, parsed.error, "error");
				return;
			}
			result = await runCreate(
				runContainer,
				{ image: parsed.tokens[0] ?? "", name: parsed.tokens[1], tier: parsed.tier },
				opts,
			);
			break;
		}
		case "run":
		case "exec":
			result = await runExec(runContainer, { machine: rest[0], command }, opts);
			break;
		case "stop":
			result = await runStop(runContainer, { name: rest[0] }, opts);
			break;
		case "remove":
		case "rm":
		case "delete": {
			const name = rest[0] ?? "";
			const confirmed = ctx.hasUI
				? await ctx.ui.confirm(
						"¿Eliminar la máquina del contenedor?",
						`Esto elimina permanentemente la máquina "${name}".`,
					)
				: false;
			result = await runRemove(runContainer, { name, force: confirmed }, opts);
			break;
		}
		default:
			notify(ctx, `Subcomando desconocido: ${action}\n\n${HELP_TEXT}`, "warning");
			return;
	}
	notify(ctx, result.text, result.ok ? "info" : "error");
}

// --------------------------------------------------------------------------
// Adaptador del resultado de la tool
// --------------------------------------------------------------------------

function toToolResult(result: HandlerResult) {
	return {
		content: [{ type: "text" as const, text: result.text }],
		details: result.details,
	};
}

// --------------------------------------------------------------------------
// Entrada de la extensión
// --------------------------------------------------------------------------

export default function containerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("container", {
		description: "Gestioná sandboxes de Apple container: status | list | create | run | stop | remove",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/);
			if (tokens.length > 1) {
				// `create … --size <tier>`: completa los nombres de tier.
				const prev = tokens[tokens.length - 2];
				if (tokens[0] === "create" && (prev === "--size" || prev === "--tier")) {
					const needle = (tokens[tokens.length - 1] ?? "").toLowerCase();
					const tiers = TIER_NAMES.filter((t) => t.startsWith(needle));
					return tiers.length > 0 ? tiers.map((t) => ({ value: t, label: t })) : null;
				}
				return null;
			}
			const needle = (tokens[0] ?? "").toLowerCase();
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(needle));
			return items.length > 0 ? items.map((sub) => ({ value: sub, label: sub })) : null;
		},
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});

	pi.registerTool({
		name: "container_sandbox",
		label: "Container Sandbox",
		description:
			"Gestioná sandboxes de Apple `container` (entornos Linux en micro-VMs livianas) en macOS/Apple Silicon. Acciones: 'status' (resumen del subsistema y las máquinas), 'list' (lista las máquinas del contenedor), 'create' (crea una máquina a partir de una imagen OCI), 'run' (ejecuta un comando aislado dentro de una máquina existente O un contenedor efímero), 'stop' (detiene una máquina), 'remove' (elimina una máquina; requiere force). `container` se invoca con un array argv, nunca con un shell.",
		promptSnippet: "Gestioná sandboxes de Apple container: status/list/create/run/stop/remove de micro-VMs Linux.",
		promptGuidelines: [
			"Usá container_sandbox para correr comandos Linux no confiables o aislados dentro de micro-VMs de Apple `container` en vez de correrlos directamente en el host.",
			"Para la acción 'run', pasá 'command' como un array argv (ej. [\"uname\",\"-a\"]) más 'machine' (una máquina existente) o 'image' (contenedor efímero). Nunca embebas un string de shell.",
			"container_sandbox 'remove' nunca elimina por defecto: pasá force:true solo cuando el usuario acepta explícitamente eliminar la máquina.",
			"Preferí un nivel de tamaño con nombre para 'create' (small/medium/large; la CLI requiere >= 1G para máquinas) y para 'run' efímero (cualquier nivel, incl. micro/tiny): sin uno, la CLI usa por defecto la MITAD de la RAM del host como memoria de la máquina. cpus/memory explícitos pisan el nivel; los niveles nunca aplican a un run dentro de una máquina existente.",
			"Apple `container` necesita macOS en Apple Silicon, `brew install container`, un kernel configurado, y un subsistema iniciado; mostrá la guía de instalación/inicio en vez de reintentar a ciegas.",
		],
		parameters: Type.Object({
			action: StringEnum(SUBCOMMANDS),
			name: Type.Optional(
				Type.String({ description: "Nombre de la máquina (para create/stop/remove, o el destino de run)." }),
			),
			image: Type.Optional(
				Type.String({ description: "Imagen OCI (para create, o run efímero), ej. alpine:latest." }),
			),
			command: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Para run: el comando como array argv (ej. ["uname","-a"]).',
				}),
			),
			machine: Type.Optional(
				Type.String({ description: "Para run: máquina existente donde ejecutar (si no, efímero vía image)." }),
			),
			workdir: Type.Optional(Type.String({ description: "Para run: directorio de trabajo dentro del contenedor." })),
			tier: Type.Optional(
				StringEnum(TIER_NAMES, {
					description:
						"Para create o run efímero: preset de tamaño con nombre (micro 1cpu/256M, tiny 2cpu/512M, small 2cpu/1G, medium 4cpu/2G, large 8cpu/4G). create solo acepta small+ (la CLI requiere >= 1G para máquinas); micro/tiny son solo para run efímero. cpus/memory explícitos lo pisan.",
				}),
			),
			cpus: Type.Optional(Type.Number({ description: "Para create o run efímero: cantidad de CPUs virtuales." })),
			memory: Type.Optional(
				Type.String({ description: "Para create o run efímero: asignación de memoria, ej. 8G." }),
			),
			homeMount: Type.Optional(StringEnum(["ro", "rw", "none"] as const)),
			setDefault: Type.Optional(Type.Boolean({ description: "Para create: marcar esta máquina como la default." })),
			force: Type.Optional(Type.Boolean({ description: "Para remove: confirma eliminar la máquina." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!isSupportedPlatform()) {
				return {
					content: [{ type: "text" as const, text: PLATFORM_MSG }],
					details: { isError: true, action: params.action },
				};
			}
			const opts = { cwd: ctx.cwd, signal: signal ?? undefined };
			switch (params.action) {
				case "status":
					return toToolResult(await runStatus(runContainer, opts));
				case "list":
					return toToolResult(await runList(runContainer, opts));
				case "create":
					return toToolResult(
						await runCreate(
							runContainer,
							{
								image: params.image ?? "",
								name: params.name,
								tier: params.tier,
								cpus: params.cpus,
								memory: params.memory,
								homeMount: params.homeMount,
								setDefault: params.setDefault,
							},
							opts,
						),
					);
				case "run":
					return toToolResult(
						await runExec(
							runContainer,
							{
								command: params.command ?? [],
								machine: params.machine ?? params.name,
								image: params.image,
								workdir: params.workdir,
								tier: params.tier,
								cpus: params.cpus,
								memory: params.memory,
							},
							opts,
						),
					);
				case "stop":
					return toToolResult(await runStop(runContainer, { name: params.name }, opts));
				case "remove":
					return toToolResult(
						await runRemove(runContainer, { name: params.name ?? "", force: params.force }, opts),
					);
				default:
					return {
						content: [{ type: "text" as const, text: `Acción desconocida: ${params.action}` }],
						details: { isError: true },
					};
			}
		},
	});
}
