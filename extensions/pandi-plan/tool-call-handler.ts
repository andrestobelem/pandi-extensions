/**
 * Manejador pi.on("tool_call") del gate de solo lectura en modo plan.
 */

import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { blockedReason } from "./gate.js";
import { planModeActive } from "./plan-guard.js";

/**
 * Gatea SOLO mientras el modo plan está activo y bloquea DURO en lugar de confirmar.
 */
export async function handleToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
	if (!planModeActive()) return undefined;
	const reason = blockedReason(event);
	if (!reason) return undefined;
	return { block: true, reason };
}
