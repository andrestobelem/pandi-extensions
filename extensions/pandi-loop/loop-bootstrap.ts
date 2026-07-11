import { configureLifecycle, stopLoop } from "./lifecycle.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { makeLoopIterationPrompt } from "./prompt.js";
import { configureScheduler } from "./scheduler.js";
import { configureRecovery } from "./session-recovery.js";
import type { ActiveLoop } from "./state.js";
import { setLoopStatus } from "./status.js";

export function configureLoopEngine(activeLoops: Map<string, ActiveLoop>): void {
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
}
