import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_NAME } from "./derive-name.js";
import { notify } from "./notify.js";
import { handleSessionStart, registerSessionInfoChanged, setSessionExitHintName } from "./session-hooks.js";
import { applyName, readEntries } from "./session-name.js";
import { runPiSummary } from "./spawn-summary.js";
import { summarizeSessionName } from "./summarize-name.js";

export async function handleRenameCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	onApplied?: (name: string) => void,
): Promise<void> {
	const trimmed = args.trim();
	if (trimmed) {
		applyName(pi, ctx, trimmed, onApplied);
		return;
	}
	notify(ctx, "Generando un nombre a partir de la conversación reciente\u2026", "info");
	const { name, fellBack } = await summarizeSessionName({
		entries: readEntries(ctx),
		runSummary: (prompt) => runPiSummary(prompt, { cwd: ctx.cwd }),
		defaultName: DEFAULT_SESSION_NAME,
	});
	applyName(pi, ctx, name, onApplied);
	if (fellBack) notify(ctx, "Se usó un nombre determinístico (resumen de conversación no disponible).", "info");
}

export function registerRenameCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rename", {
		description:
			"Renombra la sesión actual con un slug. Sin argumento, resume tu actividad más reciente mediante el LLM.",
		handler: async (args, ctx) => await handleRenameCommand(pi, args, ctx, setSessionExitHintName),
	});
	pi.on("session_start", async (_event, ctx) => handleSessionStart(pi, ctx));
	registerSessionInfoChanged(pi);
}
