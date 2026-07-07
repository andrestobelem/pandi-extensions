/**
 * pandi-kitty: controla el terminal kitty en ejecución desde Pi vía su protocolo
 * de control remoto (`kitty @ ...`).
 *
 * Dos superficies (convención del proyecto; ver pandi-worktree):
 *   - `/kitty`         comando slash para personas (tab | window | vsplit | hsplit | layout <nombre>)
 *   - `kitty_remote`   tool invocable por el modelo (acciones explícitas)
 *
 * Ambas comparten los manejadores puros de `./kitty.ts`. `kitty` siempre se invoca con
 * un array ARGV (nunca un string de shell).
 *
 * Requiere `allow_remote_control yes` en kitty.conf (o `-o allow_remote_control=yes` al
 * arrancar kitty) y correr DESDE una sesión de kitty en ejecución.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseKittyCommand } from "./command.js";
import {
	DEFAULT_KITTY_TIMEOUT_MS,
	type HandlerResult,
	parseTimeoutMs,
	runCloseWindow,
	runFocusWindow,
	runGotoLayout,
	runKitty,
	runLaunch,
	SPLIT_LOCATIONS,
	WINDOW_TYPES,
} from "./kitty.js";
import { notify } from "./notify.js";

export { parseKittyCommand } from "./command.js";
export {
	buildCloseWindowArgs,
	buildFocusWindowArgs,
	buildGotoLayoutArgs,
	buildLaunchArgs,
	describeError,
	runCloseWindow,
	runFocusWindow,
	runGotoLayout,
	runKitty,
	runLaunch,
	SPLIT_LOCATIONS,
	WINDOW_TYPES,
} from "./kitty.js";

const HELP_TEXT = [
	"Uso:",
	"  /kitty tab                new tab",
	"  /kitty window              nueva ventana (según el layout activo)",
	"  /kitty vsplit               nueva ventana en split vertical",
	"  /kitty hsplit               nueva ventana en split horizontal",
	"  /kitty os-window            nueva ventana de OS",
	"  /kitty layout <nombre>       cambia el layout activo (ej. splits, tall, fat, grid)",
	"  /kitty close [id]            cierra una ventana (la activa si se omite el id)",
	"  /kitty focus <id>            enfoca una ventana por id",
	"",
	"Requiere `allow_remote_control yes` en kitty.conf y correr desde una sesión de kitty.",
].join("\n");

function buildOpts(cwd: string, signal: AbortSignal | null | undefined) {
	return {
		cwd,
		signal: signal ?? undefined,
		timeoutMs: parseTimeoutMs(process.env.PI_KITTY_TIMEOUT_MS, DEFAULT_KITTY_TIMEOUT_MS),
	};
}

// --------------------------------------------------------------------------
// Handler del comando
// --------------------------------------------------------------------------

async function runCommand(ctx: ExtensionContext, input: string): Promise<void> {
	const { action, rest } = parseKittyCommand(input);
	const opts = buildOpts(ctx.cwd, ctx.signal);

	if (action === "help" || action === "-h" || action === "--help") {
		notify(ctx, HELP_TEXT, "info");
		return;
	}

	let result: HandlerResult;
	switch (action) {
		case "tab":
			result = await runLaunch(runKitty, { type: "tab" }, opts);
			break;
		case "window":
			result = await runLaunch(runKitty, { type: "window" }, opts);
			break;
		case "vsplit":
			result = await runLaunch(runKitty, { type: "window", location: "vsplit" }, opts);
			break;
		case "hsplit":
			result = await runLaunch(runKitty, { type: "window", location: "hsplit" }, opts);
			break;
		case "os-window":
			result = await runLaunch(runKitty, { type: "os-window" }, opts);
			break;
		case "layout":
			result = await runGotoLayout(runKitty, { layout: rest[0] ?? "" }, opts);
			break;
		case "close":
			result = await runCloseWindow(runKitty, { matchId: rest[0] }, opts);
			break;
		case "focus":
			result = await runFocusWindow(runKitty, { matchId: rest[0] ?? "" }, opts);
			break;
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
	return { content: [{ type: "text" as const, text: result.text }], details: result.details };
}

// --------------------------------------------------------------------------
// Entrada de la extensión
// --------------------------------------------------------------------------

export default function kittyExtension(pi: ExtensionAPI): void {
	pi.registerCommand("kitty", {
		description:
			"Controlá kitty vía remote control: tab | window | vsplit | hsplit | os-window | layout | close | focus",
		handler: async (args, ctx) => {
			await runCommand(ctx, args);
		},
	});

	pi.registerTool({
		name: "kitty_remote",
		label: "Control remoto de kitty",
		description:
			"Controlá el terminal kitty en ejecución vía su protocolo de control remoto (`kitty @ ...`). Acciones: 'launch' (abre tab/window/os-window nueva, opcionalmente con split vsplit/hsplit), 'goto-layout' (cambia el layout activo), 'close-window' (cierra una ventana), 'focus-window' (enfoca una ventana por id). Requiere `allow_remote_control yes` en kitty.conf y correr desde una sesión de kitty en ejecución.",
		promptSnippet: "Controlá kitty (tabs, ventanas, splits, layout) vía su protocolo de control remoto.",
		promptGuidelines: [
			"Usá kitty_remote para abrir tabs/ventanas/splits de kitty o cambiar su layout en lugar de instruir al usuario a hacerlo manualmente.",
			"Para 'launch' con type:'window', pasá location:'vsplit' o 'hsplit' para un split; el split solo se ve como tal si el layout activo es 'splits' (usá goto-layout primero si hace falta).",
			"Si kitty_remote falla con un error de socket, es porque no hay remote control habilitado (allow_remote_control yes en kitty.conf) o no se está corriendo desde dentro de una sesión de kitty — no reintentes a ciegas, avisale al usuario.",
		],
		parameters: Type.Object({
			action: StringEnum(["launch", "goto-layout", "close-window", "focus-window"] as const),
			type: Type.Optional(StringEnum(WINDOW_TYPES, { description: "Para launch: tab | os-window | window." })),
			location: Type.Optional(
				StringEnum(SPLIT_LOCATIONS, { description: "Para launch con type:'window': vsplit | hsplit." }),
			),
			layout: Type.Optional(
				Type.String({ description: "Para goto-layout: nombre del layout (ej. splits, tall, fat, grid)." }),
			),
			matchId: Type.Optional(
				Type.String({ description: "Para close-window/focus-window: id de la ventana objetivo." }),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const opts = buildOpts(ctx.cwd, signal);
			switch (params.action) {
				case "launch":
					return toToolResult(
						await runLaunch(runKitty, { type: params.type ?? "tab", location: params.location }, opts),
					);
				case "goto-layout":
					return toToolResult(await runGotoLayout(runKitty, { layout: params.layout ?? "" }, opts));
				case "close-window":
					return toToolResult(await runCloseWindow(runKitty, { matchId: params.matchId }, opts));
				case "focus-window":
					return toToolResult(await runFocusWindow(runKitty, { matchId: params.matchId ?? "" }, opts));
				default:
					return {
						content: [{ type: "text" as const, text: `Acción desconocida: ${params.action}` }],
						details: { isError: true },
					};
			}
		},
	});
}
