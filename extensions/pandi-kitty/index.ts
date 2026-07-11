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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleKittyCommand } from "./command-handler.js";
import { registerKittyRemoteTool } from "./tool-handler.js";

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

export default function kittyExtension(pi: ExtensionAPI): void {
	pi.registerCommand("kitty", {
		description:
			"Controlá kitty vía remote control: tab | window | vsplit | hsplit | os-window | layout | close | focus",
		handler: async (args, ctx) => {
			await handleKittyCommand(ctx, args);
		},
	});

	registerKittyRemoteTool(pi);
}
