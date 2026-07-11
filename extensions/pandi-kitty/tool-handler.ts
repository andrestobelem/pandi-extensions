import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SPLIT_LOCATIONS, WINDOW_TYPES } from "./kitty.js";
import { executeKittyRemote } from "./remote-tool-handler.js";

export function registerKittyRemoteTool(pi: ExtensionAPI): void {
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
			return executeKittyRemote(params, ctx, signal);
		},
	});
}
