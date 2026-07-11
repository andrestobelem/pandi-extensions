/**
 * `/loop` para Pi: ejecuta un objetivo por iteraciones programadas por el modelo
 * (`loop_schedule`) o por una cadencia fija (`/loop <task> <interval>`).
 *
 * Arquitectura modularizada al estilo pandi-plan:
 * - session-hooks.ts — session_start / shutdown / agent_end
 * - gate-patterns.ts + gate-shell-parse.ts + gate.ts — política destructiva autopilot
 * - scheduler.ts / lifecycle.ts / session-recovery.ts — motor y recuperación
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleLoopCommand } from "./command-handler.js";
import { configureLifecycle, stopLoop } from "./lifecycle.js";
import {
	handleToolCall,
	type LoopArgumentCompletion,
	registerLoopTools,
	STATIC_LOOP_ARGUMENT_COMPLETIONS,
} from "./loop-tools.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { makeLoopIterationPrompt } from "./prompt.js";
import { configureScheduler } from "./scheduler.js";
import { handleAgentEnd, handleSessionShutdown, handleSessionStart } from "./session-hooks.js";
import { configureRecovery } from "./session-recovery.js";
import type { ActiveLoop } from "./state.js";
import { setLoopStatus } from "./status.js";

const activeLoops = new Map<string, ActiveLoop>();

export default function loopExtension(pi: ExtensionAPI): void {
	configureLifecycle({
		getActiveLoops: () => activeLoops,
	});
	configureRecovery({
		getActiveLoops: () => activeLoops,
	});
	configureScheduler({
		getLoop: (loopId) => activeLoops.get(loopId),
		loops: () => activeLoops.values(),
		persist,
		setLoopStatus,
		stopLoop,
		notify,
		makeLoopIterationPrompt,
	});

	registerLoopTools(pi, activeLoops);

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

	pi.on("tool_call", async (event, ctx) => await handleToolCall(ctx, event));
	pi.on("session_start", async (event, ctx) => handleSessionStart(pi, event, ctx, activeLoops));
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(pi, ctx, activeLoops));
	pi.on("agent_end", async (_event, ctx) => handleAgentEnd(pi, ctx, activeLoops));
}
