import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_PERCENT = 30;

export const parseThreshold = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = Number(value.trim().replace(/%$/, ""));
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return undefined;
	return parsed;
};

export default function autoCompactContext(pi: ExtensionAPI) {
	let enabled = true;
	let thresholdPercent = parseThreshold(process.env.PI_AUTO_COMPACT_PERCENT) ?? DEFAULT_THRESHOLD_PERCENT;
	let previousPercent: number | null | undefined;
	let pendingReason: string | undefined;
	let compacting = false;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	const triggerCompaction = (ctx: ExtensionContext, reason: string) => {
		if (compacting) return;
		pendingReason = undefined;
		compacting = true;
		notify(ctx, `Auto-compacting context: ${reason}`, "info");

		ctx.compact({
			onComplete: () => {
				compacting = false;
				// Re-arm the edge-trigger from the POST-compaction usage, not null. If
				// compaction could not bring usage below the threshold (large pinned/
				// system content), resetting to null would re-cross every turn and loop.
				previousPercent = ctx.getContextUsage()?.percent ?? null;
				notify(ctx, "Auto-compaction completed", "info");
			},
			onError: (error) => {
				compacting = false;
				notify(ctx, `Auto-compaction failed: ${error.message}`, "error");
			},
		});
	};

	const updatePendingCompaction = (ctx: ExtensionContext) => {
		if (!enabled || compacting) return;

		const usage = ctx.getContextUsage();
		const currentPercent = usage?.percent ?? null;
		if (currentPercent === null) return;

		const crossedThreshold = previousPercent === undefined || previousPercent === null || previousPercent < thresholdPercent;
		previousPercent = currentPercent;

		if (!crossedThreshold || currentPercent < thresholdPercent) return;
		pendingReason = `${Math.round(currentPercent)}% >= ${thresholdPercent}%`;
	};

	// turn_end can fire between tool calls inside one assistant turn. Only mark
	// compaction as pending here so the active workflow is not interrupted.
	pi.on("turn_end", (_event, ctx) => {
		updatePendingCompaction(ctx);
	});

	// Compact after the assistant turn fully finishes. This preserves the work
	// flow while still compacting before the next user request.
	pi.on("agent_end", (_event, ctx) => {
		updatePendingCompaction(ctx);
		if (!enabled) {
			pendingReason = undefined;
			return;
		}
		if (!pendingReason) return;
		const reason = pendingReason;
		pendingReason = undefined;
		triggerCompaction(ctx, reason);
	});

	pi.registerCommand("auto-compact-context", {
		description: "Show, enable/disable, set, or manually trigger relative context auto-compaction threshold (default enabled at 30%)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				notify(ctx, `Auto-compaction context is ${enabled ? "enabled" : "disabled"}; threshold: ${thresholdPercent}%`, "info");
				return;
			}

			if (trimmed === "enable" || trimmed === "on") {
				enabled = true;
				previousPercent = null;
				pendingReason = undefined;
				notify(ctx, `Auto-compaction context enabled at ${thresholdPercent}%`, "info");
				return;
			}

			if (trimmed === "disable" || trimmed === "off") {
				enabled = false;
				pendingReason = undefined;
				notify(ctx, "Auto-compaction context disabled", "warning");
				return;
			}

			if (trimmed === "run" || trimmed === "compact") {
				triggerCompaction(ctx, "manual command");
				return;
			}

			const nextThreshold = parseThreshold(trimmed);
			if (nextThreshold === undefined) {
				notify(ctx, "Usage: /auto-compact-context [status|on|off|run|<1-99 percent>]", "warning");
				return;
			}

			thresholdPercent = nextThreshold;
			previousPercent = null;
			pendingReason = undefined;
			notify(ctx, `Auto-compaction context threshold set to ${thresholdPercent}%`, "info");
		},
	});
}
