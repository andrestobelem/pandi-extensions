/**
 * Hooks de sesión y frontera de turno para `/loop`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capExceeded } from "./caps.js";
import { SAFETY_NET_DELAY_SECONDS } from "./constants.js";
import { handleToolCall } from "./loop-tools.js";
import { persist } from "./persistence.js";
import {
	clearAutopilotInFlight,
	clearLoopTimer,
	clearWakeQueue,
	drainWakeQueue,
	rearmFixed,
	scheduleWake,
	stopForCap,
} from "./scheduler.js";
import { gcOldTerminalLoops, rehydrate, watchdogSweep } from "./session-recovery.js";
import type { ActiveLoop } from "./state.js";
import { clearLoopStatus } from "./status.js";

export async function handleSessionStart(
	pi: ExtensionAPI,
	event: { reason?: string },
	ctx: ExtensionContext,
	_activeLoops: Map<string, ActiveLoop>,
): Promise<void> {
	if (event.reason === "fork") return;
	await rehydrate(pi, ctx);
	await gcOldTerminalLoops(ctx).catch(() => {});
}

export function handleSessionShutdown(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	activeLoops: Map<string, ActiveLoop>,
): void {
	for (const loop of activeLoops.values()) {
		clearLoopTimer(loop);
		loop.controller.abort("cierre de sesión");
		if (loop.status === "running") {
			loop.status = "stale";
			persist(pi, ctx, loop);
		}
	}
	activeLoops.clear();
	clearWakeQueue();
	clearAutopilotInFlight();
	clearLoopStatus(ctx);
}

export function handleAgentEnd(pi: ExtensionAPI, ctx: ExtensionContext, activeLoops: Map<string, ActiveLoop>): void {
	for (const loop of activeLoops.values()) {
		loop.autopilot = false;
		if (loop.status !== "running") continue;

		const cap = capExceeded(ctx, loop);
		if (cap) {
			stopForCap(pi, ctx, loop, cap);
			continue;
		}

		if (loop.rearmedThisTurn) continue;
		if (loop.timer) continue;

		if (loop.mode === "fixed") {
			rearmFixed(pi, ctx, loop);
		} else {
			scheduleWake(pi, ctx, loop, SAFETY_NET_DELAY_SECONDS, "auto: el turno cerró sin loop_schedule");
		}
	}
	clearAutopilotInFlight();
	drainWakeQueue(pi, ctx);
	watchdogSweep(pi, ctx);
}

export function registerLoopHooks(pi: ExtensionAPI, activeLoops: Map<string, ActiveLoop>): void {
	pi.on("tool_call", async (event, ctx) => await handleToolCall(ctx, event));
	pi.on("session_start", async (event, ctx) => handleSessionStart(pi, event, ctx, activeLoops));
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(pi, ctx, activeLoops));
	pi.on("agent_end", async (_event, ctx) => handleAgentEnd(pi, ctx, activeLoops));
}
