/**
 * Workflow run lifecycle — notificación de resultados y handoff del reporte final.
 * Parte del deep module lifecycle para mantener el módulo principal enfocado en
 * lanzamiento/reanudación en segundo plano.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import { writeRunReport } from "../run-report-writer.js";
import { getRunState, getRunStatusLabel } from "../run-state.js";
import type { WorkflowRunResult } from "../types.js";

interface FinalReportHandoff {
	reportPath?: string;
	opened?: boolean;
	openCommand?: string;
	error?: string;
}

function makeWorkflowWakePrompt(result: WorkflowRunResult, handoff: FinalReportHandoff = {}): string {
	const state = getRunStatusLabel(result);
	return `Background workflow finished.

Workflow: ${result.workflow}
Run: ${result.runId}
State: ${state}
Artifacts: ${result.runDir}${handoff.reportPath ? `\nFinal report: ${handoff.reportPath}` : ""}${handoff.error ? `\nFinal report error: ${handoff.error}` : ""}

Please inspect the run with dynamic_workflow action=view name=${result.runId}, open the final report if available, read relevant artifacts if needed, and continue the user's task. If the workflow failed, went stale, or produced risks, explain that clearly and propose the next action.`;
}

function wakeAgentForWorkflowResult(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: WorkflowRunResult,
	handoff: FinalReportHandoff = {},
): void {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
	if (getRunState(result) === "cancelled") return;
	const prompt = makeWorkflowWakePrompt(result, handoff);
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function openCommandForPlatform(platform: NodeJS.Platform, htmlPath: string): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [htmlPath] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", htmlPath] };
	return { command: "xdg-open", args: [htmlPath] };
}

async function openHtmlReportBestEffort(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reportPath: string,
): Promise<Pick<FinalReportHandoff, "opened" | "openCommand">> {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return { opened: false };
	const { command, args } = openCommandForPlatform(process.platform, reportPath);
	const opened = await pi
		.exec(command, args, { cwd: ctx.cwd, timeout: 5000 })
		.then((result) => result.code === 0 && !result.killed)
		.catch(() => false);
	return { opened, openCommand: command };
}

async function writeFinalReportHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: WorkflowRunResult,
): Promise<FinalReportHandoff> {
	try {
		const report = await writeRunReport(result);
		const opened =
			getRunState(result) === "cancelled"
				? { opened: false }
				: await openHtmlReportBestEffort(pi, ctx, report.reportPath);
		return { reportPath: report.reportPath, ...opened };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function notifyWorkflowResult(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	result: WorkflowRunResult,
): Promise<void> {
	const resultState = getRunState(result);
	const type = resultState === "completed" ? "info" : resultState === "cancelled" ? "warning" : "error";
	const handoff = await writeFinalReportHandoff(pi, ctx, result);
	const reportLine = handoff.reportPath
		? `\nFinal report: ${handoff.reportPath}${handoff.opened ? "\nOpened final report in a browser." : ""}`
		: handoff.error
			? `\nFinal report: failed to render (${handoff.error})`
			: "";
	notify(
		ctx,
		`Background workflow ${getRunStatusLabel(result)}: ${result.workflow}\nRun: ${result.runId}\nArtifacts: ${result.runDir}${reportLine}`,
		type,
	);
	wakeAgentForWorkflowResult(pi, ctx, result, handoff);
}
