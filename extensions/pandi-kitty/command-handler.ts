import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseKittyCommand } from "./command.js";
import { type HandlerResult, runCloseWindow, runFocusWindow, runGotoLayout, runKitty, runLaunch } from "./kitty.js";
import { buildKittyOpts } from "./kitty-options.js";
import { notify } from "./notify.js";

export const KITTY_HELP_TEXT = [
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

export async function handleKittyCommand(ctx: ExtensionContext, input: string): Promise<void> {
	const { action, rest } = parseKittyCommand(input);
	const opts = buildKittyOpts(ctx.cwd, ctx.signal);

	if (action === "help" || action === "-h" || action === "--help") {
		notify(ctx, KITTY_HELP_TEXT, "info");
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
			notify(ctx, `Subcomando desconocido: ${action}\n\n${KITTY_HELP_TEXT}`, "warning");
			return;
	}
	notify(ctx, result.text, result.ok ? "info" : "error");
}
