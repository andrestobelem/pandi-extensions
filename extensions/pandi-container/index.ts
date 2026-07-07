/**
 * pandi-container: administra sandboxes de Apple `container` (micro-VMs Linux) desde Pi.
 *
 * Dos superficies (convención del proyecto; ver pandi-worktree):
 *   - `/container`          comando slash para personas (interactivo, confirma operaciones destructivas)
 *   - `container_sandbox`    tool invocable por el modelo (acciones explícitas, sin borrados sorpresa)
 *
 * Ambas comparten las utilidades puras y los manejadores de `./container.ts`. `container` siempre se
 * invoca con un array ARGV (nunca un string de shell), así las referencias de imagen, los nombres de máquina
 * y los comandos no pueden inyectar shell.
 *
 * Apple `container` ejecuta cada entorno Linux en su propia VM liviana
 * (Virtualization.framework) y requiere macOS en Apple Silicon, la CLI `container`
 * (`brew install container`), un kernel configurado y un subsistema iniciado.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseContainerCommand, parseSizeFlag } from "./command.js";
import { CONTAINER_ACTIONS, completeContainerArgs, resolveContainerInput } from "./command-menu.js";
import {
	DEFAULT_CONTAINER_TIMEOUT_MS,
	describeTiers,
	type HandlerResult,
	isSupportedPlatform,
	parseTimeoutMs,
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
	parseTimeoutMs,
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

const SUBCOMMANDS = CONTAINER_ACTIONS.map(({ value }) => value);

const HELP_TEXT = [
	"Uso:",
	"  /container [status]                         resumen del subsistema y las máquinas",
	"  /container list                             lista las máquinas del contenedor",
	"  /container create <image> [name] [--size <tier>]   crea una máquina (ej. alpine:latest dev --size small)",
	"  /container run <machine> -- <cmd...>        ejecuta un comando dentro de una máquina",
	"  /container stop [name]                      detiene una máquina (la default si se omite)",
	"  /container remove <name>                    elimina una máquina (pide confirmación)",
	"",
	`Niveles de tamaño: ${describeTiers()}.`,
	"Sin un nivel, la CLI usa por defecto la MITAD de la RAM del host (v1.0.0).",
	"Las máquinas necesitan >= 1G (piso de la CLI); micro/tiny solo aplican a runs efímeros.",
	"",
	"Apple `container` necesita macOS en Apple Silicon, `brew install container`, un",
	"kernel configurado (`container system kernel set --recommended`) y un subsistema",
	"iniciado (`container system start`).",
].join("\n");

const PLATFORM_MSG = "Apple `container` requiere macOS en Apple Silicon (arm64); este host no es compatible.";

export { parseContainerCommand, parseSizeFlag } from "./command.js";
export { CONTAINER_SELECT_ITEMS, completeContainerArgs, resolveContainerInput } from "./command-menu.js";

// --------------------------------------------------------------------------
// Handler del comando
// --------------------------------------------------------------------------

async function runCommand(ctx: ExtensionContext, input: string): Promise<void> {
	if (!isSupportedPlatform()) {
		notify(ctx, PLATFORM_MSG, "error");
		return;
	}
	const { action, rest, command } = parseContainerCommand(await resolveContainerInput(input, ctx));
	const opts = {
		cwd: ctx.cwd,
		signal: ctx.signal ?? undefined,
		timeoutMs: parseTimeoutMs(process.env.PI_CONTAINER_TIMEOUT_MS, DEFAULT_CONTAINER_TIMEOUT_MS),
	};

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

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function toolError(text: string, details: Record<string, unknown> = {}) {
	return toolResult(text, { isError: true, ...details });
}

function toToolResult(result: HandlerResult) {
	return toolResult(result.text, result.details);
}

// --------------------------------------------------------------------------
// Entrada de la extensión
// --------------------------------------------------------------------------

export default function containerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("container", {
		description: "Administrá sandboxes de Apple container: status | list | create | run | stop | remove",
		getArgumentCompletions: completeContainerArgs,
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});

	pi.registerTool({
		name: "container_sandbox",
		label: "Sandbox de container",
		description:
			"Administrá sandboxes de Apple `container` (entornos Linux en micro-VMs livianas) en macOS/Apple Silicon. Acciones: 'status' (resumen del subsistema y las máquinas), 'list' (lista las máquinas del contenedor), 'create' (crea una máquina a partir de una imagen OCI), 'run' (ejecuta un comando aislado dentro de una máquina existente o de un contenedor efímero), 'stop' (detiene una máquina), 'remove' (elimina una máquina; requiere force). `container` se invoca con un array argv, nunca con un shell.",
		promptSnippet: "Administrá sandboxes de Apple container: status/list/create/run/stop/remove de micro-VMs Linux.",
		promptGuidelines: [
			"Usá container_sandbox para ejecutar comandos Linux no confiables o aislados dentro de micro-VMs de Apple `container` en lugar de correrlos directamente en el host.",
			"Para la acción 'run', pasá 'command' como un array argv (ej. [\"uname\",\"-a\"]) más 'machine' (una máquina existente) o 'image' (contenedor efímero). Nunca incrustes un string de shell.",
			"container_sandbox 'remove' nunca borra por defecto: pasá force:true solo cuando el usuario acepte explícitamente eliminar la máquina.",
			"Preferí un nivel de tamaño con nombre para 'create' (small/medium/large; la CLI requiere >= 1G para máquinas) y para 'run' efímero (cualquier nivel, incl. micro/tiny): sin uno, la CLI usa por defecto la MITAD de la RAM del host como memoria de la máquina. cpus/memory explícitos pisan el nivel; los niveles nunca aplican a un run dentro de una máquina existente.",
			"Apple `container` necesita macOS en Apple Silicon, `brew install container`, un kernel configurado y un subsistema iniciado; mostrales la guía de instalación/inicio en lugar de reintentar a ciegas.",
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
				return toolError(PLATFORM_MSG, { action: params.action });
			}
			const opts = {
				cwd: ctx.cwd,
				signal: signal ?? undefined,
				timeoutMs: parseTimeoutMs(process.env.PI_CONTAINER_TIMEOUT_MS, DEFAULT_CONTAINER_TIMEOUT_MS),
			};
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
					return toolError(`Acción desconocida: ${params.action}`);
			}
		},
	});
}
