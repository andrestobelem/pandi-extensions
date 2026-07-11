/**
 * Tool `podman_sandbox` invocable por el modelo.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PODMAN_ACTIONS } from "./command-menu.js";
import { buildHandlerOpts } from "./handler-opts.js";
import {
	runList,
	runMachineList,
	runMachineStart,
	runPodman,
	runRemove,
	runSandbox,
	runStatus,
	runStop,
} from "./podman.js";
import { toolError, toToolResult } from "./tool-results.js";

const ACTIONS = PODMAN_ACTIONS.map(({ value }) => value);

export function registerPodmanSandboxTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "podman_sandbox",
		label: "Sandbox de Podman",
		description:
			"Ejecutá y administrá un subconjunto restringido de Podman. run crea solo un contenedor efímero, sin mounts, puertos, variables de entorno, privilegios ni flags libres; usa red none, rootfs read-only, capabilities eliminadas y límites de recursos por defecto. Podman siempre se invoca con argv, nunca mediante shell.",
		promptSnippet: "Usá podman_sandbox para un contenedor efímero y restringido cuando el usuario pida Podman.",
		promptGuidelines: [
			"run requiere image y command como array argv; nunca pases un string de shell.",
			"La red está deshabilitada por defecto. Usá network:'default' solo cuando el usuario o la tarea requiera explícitamente acceso de red.",
			"No hay mounts, puertos, secrets/env, devices ni privilegios en esta surface. No intentes suplirlos con argumentos de texto.",
			"remove nunca borra por defecto: pasá force:true solo después de que el usuario acepte eliminar ese contenedor.",
			"Podman no debe tratarse como una frontera infalible contra código hostil, sobre todo en Linux. Para una micro-VM Apple preferí container_sandbox cuando aplique.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS),
			name: Type.Optional(
				Type.String({ description: "Nombre de contenedor para stop/remove o de máquina para machine-start." }),
			),
			image: Type.Optional(
				Type.String({ description: "Referencia OCI para run, por ejemplo quay.io/podman/hello:latest." }),
			),
			command: Type.Optional(
				Type.Array(Type.String(), { description: 'Para run: comando como argv, por ejemplo ["uname", "-a"].' }),
			),
			network: Type.Optional(
				StringEnum(["none", "default"] as const, { description: "none por defecto; default solo como opt-in." }),
			),
			workdir: Type.Optional(Type.String({ description: "Ruta absoluta dentro del contenedor para run." })),
			cpus: Type.Optional(
				Type.Number({
					minimum: 0.1,
					maximum: 2,
					description: "Límite de CPU; solo puede endurecer el default de 2.",
				}),
			),
			memory: Type.Optional(
				Type.String({ description: "Límite entre 16M y 1G; solo puede endurecer el default de 1G." }),
			),
			force: Type.Optional(Type.Boolean({ description: "Para remove: confirma eliminar el contenedor." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const opts = buildHandlerOpts(ctx.cwd, signal);
			switch (params.action) {
				case "status":
					return toToolResult(await runStatus(runPodman, opts));
				case "list":
					return toToolResult(await runList(runPodman, opts));
				case "run":
					return toToolResult(
						await runSandbox(
							runPodman,
							{
								image: params.image ?? "",
								command: params.command ?? [],
								network: params.network,
								workdir: params.workdir,
								cpus: params.cpus,
								memory: params.memory,
							},
							opts,
						),
					);
				case "stop":
					return toToolResult(await runStop(runPodman, { name: params.name }, opts));
				case "remove":
					return toToolResult(await runRemove(runPodman, { name: params.name, force: params.force }, opts));
				case "machine-list":
					return toToolResult(await runMachineList(runPodman, opts));
				case "machine-start":
					return toToolResult(await runMachineStart(runPodman, { name: params.name }, opts));
				default:
					return toolError(`Acción desconocida: ${params.action}`);
			}
		},
	});
}
