/**
 * Tool `container_sandbox` invocable por el modelo.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PLATFORM_MSG } from "./command-handler.js";
import { CONTAINER_ACTIONS } from "./command-menu.js";
import {
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
import { buildHandlerOpts } from "./handler-opts.js";
import { toolError, toToolResult } from "./tool-results.js";

const SUBCOMMANDS = CONTAINER_ACTIONS.map(({ value }) => value);

export function registerContainerSandboxTool(pi: ExtensionAPI): void {
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
			const opts = buildHandlerOpts(ctx.cwd, signal);
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
