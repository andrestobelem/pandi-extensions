/**
 * Comando `/container` para personas.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseContainerCommand, parseSizeFlag } from "./command.js";
import { completeContainerArgs, resolveContainerInput } from "./command-menu.js";
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
} from "./container.js";
import { buildHandlerOpts } from "./handler-opts.js";
import { notify } from "./notify.js";

export const PLATFORM_MSG = "Apple `container` requiere macOS en Apple Silicon (arm64); este host no es compatible.";

export const HELP_TEXT = [
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

async function runCommand(ctx: ExtensionContext, input: string): Promise<void> {
	if (!isSupportedPlatform()) {
		notify(ctx, PLATFORM_MSG, "error");
		return;
	}
	const { action, rest, command } = parseContainerCommand(await resolveContainerInput(input, ctx));
	const opts = buildHandlerOpts(ctx.cwd, ctx.signal);

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

export function registerContainerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("container", {
		description: "Administrá sandboxes de Apple container: status | list | create | run | stop | remove",
		getArgumentCompletions: completeContainerArgs,
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});
}
