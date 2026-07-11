/**
 * Handlers de hooks de sesión para auto-compactación (lógica; el wiring vive en index.ts).
 */

import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { AutoCompactRuntime } from "./runtime.js";

export function onSessionStart(runtime: AutoCompactRuntime, _event: unknown, ctx: ExtensionContext): void {
	runtime.updateStatusBar(ctx);
}

export async function onSessionBeforeCompact(
	runtime: AutoCompactRuntime,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
) {
	runtime.writeCompactionSnapshot(ctx, event);
	return await runtime.buildFastCompaction(event, ctx);
}

export function onSessionCompact(
	runtime: AutoCompactRuntime,
	event: { compactionEntry?: { summary?: string } },
	ctx: ExtensionContext,
): void {
	runtime.finalizeCompactionSnapshot(ctx, event);
}

export function onContext(runtime: AutoCompactRuntime, event: { messages: unknown[] }) {
	return runtime.handleContextHook(event);
}

export function onTurnEnd(runtime: AutoCompactRuntime, _event: unknown, ctx: ExtensionContext): void {
	runtime.updatePendingCompaction(ctx);
	runtime.updateStatusBar(ctx);
}

export function onAgentEnd(runtime: AutoCompactRuntime, _event: unknown, ctx: ExtensionContext): void {
	runtime.updatePendingCompaction(ctx);
	if (!runtime.enabled) {
		runtime.pendingReason = undefined;
		runtime.updateStatusBar(ctx);
		return;
	}
	if (!runtime.pendingReason) {
		runtime.updateStatusBar(ctx);
		return;
	}
	const reason = runtime.pendingReason;
	runtime.pendingReason = undefined;
	runtime.triggerCompaction(ctx, reason);
}
