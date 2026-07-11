/**
 * Barrel del motor de `/goal`: reexporta módulos del engine para consumidores legacy.
 */

export { activeGoal, activeGoals } from "./active-goals.js";
export {
	rehydrate,
	resolveGoal,
	startGoal,
} from "./goal-lifecycle.js";
export { stopGoal } from "./goal-stop.js";
export { advanceGoal, contextBudgetExceeded, normalizeWaitSeconds, scheduleGoal } from "./scheduler.js";
export { beginIndependentVerification } from "./verification.js";
