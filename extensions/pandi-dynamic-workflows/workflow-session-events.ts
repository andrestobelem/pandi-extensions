import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	abortActiveWorkflowRuns,
	interruptActiveWorkflowRunsForReload,
	resumeReloadInterruptedWorkflowRuns,
} from "./lifecycle/index.js";
import { startPiSessionHeartbeat, stopPiSessionHeartbeat } from "./pi-session.js";
import {
	clearWorkflowWidget,
	installWorkflowDashboardDownEditor,
	refreshActiveWorkflowStatus,
	setWorkflowIdleStatus,
} from "./tui/index.js";
import {
	clearUltracodeContractGateStatus,
	clearUltracodeStatus,
	ensureDynamicWorkflowToolActive,
	setUltracodeContractGateStatus,
	setUltracodeStatus,
} from "./ultracode/index.js";

type WorkflowSessionEventState = {
	getAlwaysOn: () => boolean;
	getContractGateEnabled: () => boolean;
	setCurrentCtx: (ctx: ExtensionContext | undefined) => void;
};

// Etiqueta incrustada en el borde superior del editor (línea de prompt violeta) mientras
// el enrutamiento Ultracode siempre activo está activo, para que el estado del enrutador también sea visible ahí.
const ULTRACODE_BORDER_LABEL = "ultracode auto";

export function registerWorkflowSessionEvents(pi: ExtensionAPI, state: WorkflowSessionEventState): void {
	pi.on("session_start", async (event, ctx) => {
		state.setCurrentCtx(ctx);
		await startPiSessionHeartbeat(event, ctx);
		installWorkflowDashboardDownEditor(pi, ctx, () => (state.getAlwaysOn() ? ULTRACODE_BORDER_LABEL : undefined));
		if (state.getAlwaysOn()) ensureDynamicWorkflowToolActive(pi);
		refreshActiveWorkflowStatus(ctx);
		setUltracodeStatus(ctx, state.getAlwaysOn());
		setUltracodeContractGateStatus(ctx, state.getContractGateEnabled());
		if (event.reason === "reload") await resumeReloadInterruptedWorkflowRuns(pi, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		await stopPiSessionHeartbeat();
		if (event.reason === "reload") await interruptActiveWorkflowRunsForReload();
		else await abortActiveWorkflowRuns("Workflow cancelled by session shutdown.");
		clearWorkflowWidget(ctx);
		setWorkflowIdleStatus(ctx);
		clearUltracodeStatus(ctx);
		clearUltracodeContractGateStatus(ctx);
		state.setCurrentCtx(undefined);
	});
}
