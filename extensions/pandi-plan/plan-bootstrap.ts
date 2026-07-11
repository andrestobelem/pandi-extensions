import { getActivePlans, refreshPlanStatus } from "./active-plans.js";
import { configureCommandHandler } from "./command-handler.js";
import { configurePlanGuard } from "./plan-guard.js";
import { configureRehydrate } from "./rehydrate.js";

export function configurePlanExtension(): void {
	configurePlanGuard({ getActivePlans });
	configureRehydrate({ getActivePlans, refreshPlanStatus });
	configureCommandHandler({ getActivePlans, refreshPlanStatus });
}
