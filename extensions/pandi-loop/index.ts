/**
 * `/loop` para Pi: ejecuta un objetivo por iteraciones programadas por el modelo
 * (`loop_schedule`) o por una cadencia fija (`/loop <task> <interval>`).
 *
 * Arquitectura:
 * - los wakes viven en memoria (`activeLoops` + `setTimeout`) y se materializan
 *   reinyectando un prompt con `pi.sendUserMessage`;
 * - cada transición se persiste en JSONL y en un sidecar atómico con `updatedAt`;
 * - al recargar, `session_start` rehidrata el estado más nuevo y entrega como máximo
 *   un catch-up tick;
 * - una FIFO a nivel módulo serializa wakes de múltiples loops para mantener un solo
 *   turno autopilot activo;
 * - `agent_end` es la red de seguridad: limpia flags, aplica caps y rearma fixed mode.
 *
 * Invariantes de seguridad:
 * - no correr en `print` ni reinyectar fuera de `tui`/`rpc`;
 * - clampear `delaySeconds` dinámicos a [60, 3600] dentro del tool;
 * - confirmar o bloquear tools destructivas cuando el turno es autopilot;
 * - exigir trust + confirmación explícita para `/loop auto`, y revalidar trust al
 *   rehidratar;
 * - no migrar loops al hacer fork de sesión;
 * - limitar loops activos, iteraciones, wall-clock, contexto y zombies por watchdog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capExceeded } from "./caps.js";
import { handleLoopCommand } from "./command-handler.js";
import { SAFETY_NET_DELAY_SECONDS } from "./constants.js";
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
import {
	clearAutopilotInFlight,
	clearLoopTimer,
	clearWakeQueue,
	configureScheduler,
	drainWakeQueue,
	rearmFixed,
	scheduleWake,
	stopForCap,
} from "./scheduler.js";
import { configureRecovery, gcOldTerminalLoops, rehydrate, watchdogSweep } from "./session-recovery.js";
import type { ActiveLoop } from "./state.js";
import { clearLoopStatus, setLoopStatus } from "./status.js";

// Fuente de verdad de los loops vivos en este proceso.
const activeLoops = new Map<string, ActiveLoop>();

// ---------------------------------------------------------------------------
// Punto de entrada de la extensión
// ---------------------------------------------------------------------------

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

	// Bloquear/confirmar tools destructivas solo en turnos autopilot.
	pi.on("tool_call", async (event, ctx) => await handleToolCall(ctx, event));

	pi.on("session_start", async (event, ctx) => {
		// NO migrar un loop a una sesión forked: un fork hereda las entradas "loop-state"
		// del padre, pero el loop debe seguir corriendo solo en el padre.
		// startup / reload / resume SÍ rehidratan; "new" no trae entradas del padre.
		if (event.reason === "fork") return;
		await rehydrate(pi, ctx);
		// GC después de rehydrate: los loops vivos ya están en activeLoops y no se recolectan.
		await gcOldTerminalLoops(ctx).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const loop of activeLoops.values()) {
			clearLoopTimer(loop);
			loop.controller.abort("cierre de sesión");
			if (loop.status === "running") {
				// Persistir como "stale" (recuperable en el próximo session_start), manteniendo nextFireAt intacto.
				loop.status = "stale";
				persist(pi, ctx, loop);
			}
			// "paused" se deja tal cual para que se rehidrate como paused. Estados terminales intactos.
		}
		// Limpiar el set in-memory vivo, la cola y el gate in-flight: los snapshots persistidos
		// de arriba son la fuente de verdad del próximo session_start. Mantener acá objetos
		// ActiveLoop stale/paused haría que un reload del mismo proceso saltee rehydrate vía
		// activeLoops.has(...) y deje sin timer armado.
		activeLoops.clear();
		clearWakeQueue();
		clearAutopilotInFlight();
		clearLoopStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Fin de un turno autopilot: limpiar el flag autopilot por loop (el próximo turno del usuario
		// no debe gatearse). Después correr la safety net (cubre dynamic + fixed + caps).
		for (const loop of activeLoops.values()) {
			loop.autopilot = false;
			if (loop.status !== "running") continue;

			// Gate de caps antes de cualquier rearmado: si un deadline/budget ya está agotado,
			// detener limpiamente en vez de programar otra iteración.
			const cap = capExceeded(ctx, loop);
			if (cap) {
				stopForCap(pi, ctx, loop, cap);
				continue;
			}

			if (loop.rearmedThisTurn) continue;
			if (loop.timer) continue;

			if (loop.mode === "fixed") {
				// Modo fixed: rearmar por el período propio (timestamp absoluto, sin solapamiento).
				rearmFixed(pi, ctx, loop);
			} else {
				// Modo dynamic: el modelo no llamó a loop_schedule este turno → rearmado defensivo.
				scheduleWake(pi, ctx, loop, SAFETY_NET_DELAY_SECONDS, "auto: el turno cerró sin loop_schedule");
			}
		}
		// El turno autopilot terminó: liberar el gate in-flight y entregar el SIGUIENTE wake
		// encolado (si hay) — acá es donde los loops que perdieron la carrera por este turno reciben el suyo.
		clearAutopilotInFlight();
		drainWakeQueue(pi, ctx);
		// Barrido anti-zombie oportunista en cada frontera de turno (barato; el timer periódico
		// cubre huecos idle). Force-stoppea cualquier loop pasado su deadline duro de respaldo.
		watchdogSweep(pi, ctx);
	});
}
