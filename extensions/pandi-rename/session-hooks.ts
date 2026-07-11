import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installExitNameHint } from "./exit-name-hint.js";
import { installNameBorderLabel, safeName } from "./name-border-editor.js";

/** Setter que alimenta la pista de salida "Nombre de sesión: <slug>" (undefined fuera de TTY). */
let setExitHintName: ((name: string | undefined) => void) | undefined;

export function setSessionExitHintName(name: string | undefined): void {
	setExitHintName?.(name);
}

export function handleSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): void {
	installNameBorderLabel(pi, ctx);
	if (ctx.mode === "tui") {
		setExitHintName ??= installExitNameHint({
			isTTY: () => process.stdout.isTTY === true,
			onExit: (hook) => void process.on("exit", hook),
			write: (text) => void process.stdout.write(text),
		});
		setExitHintName?.(safeName(pi));
	}
}

export function registerSessionInfoChanged(pi: ExtensionAPI): void {
	const onAny = pi.on as unknown as (
		event: string,
		handler: (event: { name?: string }, ctx: ExtensionContext) => Promise<void>,
	) => void;
	onAny("session_info_changed", async (event) => {
		setExitHintName?.(event.name);
	});
}
