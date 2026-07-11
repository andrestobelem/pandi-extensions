/**
 * `/loop` para Pi: ejecuta un objetivo por iteraciones programadas por el modelo
 * (`loop_schedule`) o por una cadencia fija (`/loop <task> <interval>`).
 *
 * Arquitectura modularizada al estilo pandi-plan:
 * - loop-bootstrap.ts — configureLifecycle / Recovery / Scheduler
 * - loop-tools.ts — tools loop_schedule / loop_stop
 * - command-handler.ts — `/loop`
 * - session-hooks.ts — tool_call / session_start / shutdown / agent_end
 * - gate-patterns.ts + gate-shell-parse.ts + gate.ts — política destructiva autopilot
 * - scheduler.ts / lifecycle.ts / session-recovery.ts — motor y recuperación
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLoopCommand } from "./command-handler.js";
import { configureLoopEngine } from "./loop-bootstrap.js";
import { registerLoopTools } from "./loop-tools.js";
import { registerLoopHooks } from "./session-hooks.js";
import type { ActiveLoop } from "./state.js";

const activeLoops = new Map<string, ActiveLoop>();

export default function loopExtension(pi: ExtensionAPI): void {
	configureLoopEngine(activeLoops);
	registerLoopTools(pi, activeLoops);
	registerLoopCommand(pi, activeLoops);
	registerLoopHooks(pi, activeLoops);
}
