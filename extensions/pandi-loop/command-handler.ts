import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseLoopCommandIntent } from "./command-intent.js";
import { pauseLoop, resumeLoop, startAutonomousLoop, startLoop, stopLoop } from "./lifecycle.js";
import { resolveLoop } from "./loop-resolve.js";
import { type LoopArgumentCompletion, STATIC_LOOP_ARGUMENT_COMPLETIONS } from "./loop-tools.js";
import { notify } from "./notify.js";
import type { ActiveLoop } from "./state.js";
import { formatStatus } from "./status.js";

function formatLoopStatusList(loops: ActiveLoop[]): string {
	return loops.map(formatStatus).join("\n");
}

export async function handleLoopCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionContext,
	activeLoops: Map<string, ActiveLoop>,
): Promise<void> {
	const intent = parseLoopCommandIntent(args);

	if (intent.kind === "stop") {
		const loop = await resolveLoop(ctx, activeLoops, intent.rest || undefined, ["running", "paused"]);
		if (!loop) {
			notify(
				ctx,
				"No hay ningún loop que coincida para detener. Usá /loop status para ver los loops activos.",
				"warning",
			);
			return;
		}
		stopLoop(pi, ctx, loop.loopId, "detenido por el usuario (/loop stop)", "stopped");
		notify(ctx, `Loop ${loop.loopId} detenido.`, "info");
		return;
	}

	if (intent.kind === "pause") {
		const loop = await resolveLoop(ctx, activeLoops, intent.rest || undefined, ["running"]);
		if (!loop) {
			notify(
				ctx,
				"No hay ningún loop corriendo para pausar. Usá /loop status para ver los loops activos.",
				"warning",
			);
			return;
		}
		if (pauseLoop(pi, ctx, loop)) notify(ctx, `Loop ${loop.loopId} pausado.`, "info");
		else notify(ctx, `El loop ${loop.loopId} no está corriendo.`, "warning");
		return;
	}

	if (intent.kind === "resume") {
		const loop = await resolveLoop(ctx, activeLoops, intent.rest || undefined, ["paused"]);
		if (!loop) {
			notify(
				ctx,
				"No hay ningún loop pausado para reanudar. Usá /loop status para ver los loops activos.",
				"warning",
			);
			return;
		}
		if (resumeLoop(pi, ctx, loop)) notify(ctx, `Loop ${loop.loopId} reanudado.`, "info");
		else notify(ctx, `El loop ${loop.loopId} no está pausado.`, "warning");
		return;
	}

	if (intent.kind === "auto") {
		await startAutonomousLoop(pi, ctx, intent.rest);
		return;
	}

	if (intent.kind === "status") {
		if (intent.rest) {
			const loop = activeLoops.get(intent.rest);
			notify(
				ctx,
				loop
					? formatStatus(loop)
					: `No hay ningún loop con id ${intent.rest}. Usá /loop status para listar los loops activos.`,
				loop ? "info" : "warning",
			);
			return;
		}
		const all = [...activeLoops.values()];
		if (all.length === 0) {
			notify(ctx, "No hay loops.", "info");
			return;
		}
		notify(ctx, formatLoopStatusList(all), "info");
		return;
	}

	// Si no: args entero es la tarea (posiblemente con un token interval al final).
	startLoop(pi, ctx, intent.rest);
}

export function registerLoopCommand(pi: ExtensionAPI, activeLoops: Map<string, ActiveLoop>): void {
	pi.registerCommand("loop", {
		description:
			"Corré una tarea de forma iterativa: /loop [--ultracode] <task> [interval] | /loop auto [--ultracode] <objective> [interval] | /loop stop [id] | /loop pause [id] | /loop resume [id] | /loop status [id]. El interval (p. ej. 5m, 30s, 2h) corre en una cadencia fija; omitilo para que lo module el modelo. 'auto' inicia un loop autónomo (requiere un proyecto de confianza + confirmación). --ultracode conduce las iteraciones vía dynamic workflows.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items: LoopArgumentCompletion[] = [...STATIC_LOOP_ARGUMENT_COMPLETIONS];
			for (const loop of activeLoops.values()) {
				if (loop.status === "running" || loop.status === "paused") {
					items.push({ value: loop.loopId, label: loop.loopId, description: loop.task });
				}
			}
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.toLowerCase().startsWith(prefix));
		},
		handler: async (args, ctx) => await handleLoopCommand(pi, args, ctx, activeLoops),
	});
}
