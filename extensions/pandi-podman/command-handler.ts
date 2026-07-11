/**
 * Comando `/podman` para personas.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePodmanCommand, parseRunOptions } from "./command.js";
import { completePodmanArgs, resolvePodmanInput } from "./command-menu.js";
import { buildHandlerOpts } from "./handler-opts.js";
import { notify } from "./notify.js";
import {
	type HandlerResult,
	runList,
	runMachineList,
	runMachineStart,
	runPodman,
	runRemove,
	runSandbox,
	runStatus,
	runStop,
} from "./podman.js";

export const HELP_TEXT = [
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

export function registerPodmanCommand(pi: ExtensionAPI): void {
	pi.registerCommand("podman", {
		description: "Administrá sandboxes de Podman: status | list | run | stop | remove | machine-list | machine-start",
		getArgumentCompletions: completePodmanArgs,
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});
}
