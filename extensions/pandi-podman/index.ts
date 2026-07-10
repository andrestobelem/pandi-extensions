/**
 * pandi-podman: superficie reducida de Podman para Pi.
 *
 * Dos superficies coherentes:
 *   - `/podman`       comando humano con selector y confirmación destructiva.
 *   - `podman_sandbox` tool explícita para el modelo, sin flags libres.
 *
 * La extensión es portable (Podman en Linux/macOS/Windows) pero en macOS y
 * Windows los contenedores viven dentro de una Podman machine. Por eso expone
 * solo listar/iniciar máquinas, nunca crear, parar ni borrar una VM.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parsePodmanCommand, parseRunOptions } from "./command.js";
import { completePodmanArgs, PODMAN_ACTIONS, resolvePodmanInput } from "./command-menu.js";
import { notify } from "./notify.js";
import {
	DEFAULT_PODMAN_TIMEOUT_MS,
	type HandlerResult,
	parseTimeoutMs,
	runList,
	runMachineList,
	runMachineStart,
	runPodman,
	runRemove,
	runSandbox,
	runStatus,
	runStop,
} from "./podman.js";

export { parsePodmanCommand, parseRunOptions } from "./command.js";
export { completePodmanArgs, PODMAN_SELECT_ITEMS, resolvePodmanInput } from "./command-menu.js";
export {
	buildInfoArgs,
	buildListArgs,
	buildMachineListArgs,
	buildMachineStartArgs,
	buildRemoveArgs,
	buildRunArgs,
	buildStopArgs,
	describePodmanError,
	formatContainerList,
	formatMachineList,
	parseContainerList,
	parseInfo,
	parseMachineList,
	parseTimeoutMs,
	runList,
	runMachineList,
	runMachineStart,
	runPodman,
	runRemove,
	runSandbox,
	runStatus,
	runStop,
	validateContainerName,
	validateImageReference,
} from "./podman.js";

const ACTIONS = PODMAN_ACTIONS.map(({ value }) => value);
const HELP_TEXT = [
	"Uso:",
	"  /podman [status]                                  resumen de Podman",
	"  /podman list                                      lista todos los contenedores",
	"  /podman run [--network none|default] <image> -- <cmd...>  sandbox efímero restringido",
	"  /podman stop <container>                          detiene un contenedor",
	"  /podman remove <container>                        elimina un contenedor (pide confirmación)",
	"  /podman machine-list                              lista las máquinas de Podman",
	"  /podman machine-start [name]                      inicia una máquina existente",
	"",
	"Los sandboxes no montan el host, no publican puertos, eliminan capacidades y usan red none por defecto.",
	"`--network default` es opt-in; no hay flags libres ni acceso a secretos del host.",
].join("\n");

function buildHandlerOpts(cwd: string, signal: AbortSignal | null | undefined) {
	return {
		cwd,
		signal: signal ?? undefined,
		timeoutMs: parseTimeoutMs(process.env.PI_PODMAN_TIMEOUT_MS, DEFAULT_PODMAN_TIMEOUT_MS),
	};
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function toolError(text: string, details: Record<string, unknown> = {}) {
	return toolResult(text, { isError: true, ...details });
}

function toToolResult(result: HandlerResult) {
	return toolResult(result.text, result.details);
}

async function runCommand(ctx: ExtensionContext, input: string): Promise<void> {
	const parsed = parsePodmanCommand(await resolvePodmanInput(input, ctx));
	const opts = buildHandlerOpts(ctx.cwd, ctx.signal);
	if (parsed.action === "help" || parsed.action === "-h" || parsed.action === "--help") {
		notify(ctx, HELP_TEXT, "info");
		return;
	}

	let result: HandlerResult;
	switch (parsed.action) {
		case "status":
			result = await runStatus(runPodman, opts);
			break;
		case "list":
		case "ls":
			result = await runList(runPodman, opts);
			break;
		case "run": {
			const runOptions = parseRunOptions(parsed.rest);
			if (runOptions.error) {
				notify(ctx, runOptions.error, "warning");
				return;
			}
			result = await runSandbox(
				runPodman,
				{ image: runOptions.image ?? "", network: runOptions.network, command: parsed.command },
				opts,
			);
			break;
		}
		case "stop":
			result = await runStop(runPodman, { name: parsed.rest[0] }, opts);
			break;
		case "remove":
		case "rm": {
			const name = parsed.rest[0] ?? "";
			const force = ctx.hasUI
				? await ctx.ui.confirm(
						"¿Eliminar el contenedor de Podman?",
						`Esto elimina permanentemente el contenedor "${name}".`,
					)
				: false;
			result = await runRemove(runPodman, { name, force }, opts);
			break;
		}
		case "machine-list":
			result = await runMachineList(runPodman, opts);
			break;
		case "machine-start":
			result = await runMachineStart(runPodman, { name: parsed.rest[0] }, opts);
			break;
		default:
			notify(ctx, `Subcomando desconocido: ${parsed.action}\n\n${HELP_TEXT}`, "warning");
			return;
	}
	notify(ctx, result.text, result.ok ? "info" : "error");
}

export default function podmanExtension(pi: ExtensionAPI): void {
	pi.registerCommand("podman", {
		description: "Administrá sandboxes de Podman: status | list | run | stop | remove | machine-list | machine-start",
		getArgumentCompletions: completePodmanArgs,
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});

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
