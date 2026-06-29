/**
 * Ultracode router — the always-on prompt builders (routing rules, contract-gate, system
 * prompt), the dynamic-workflow tool activation helpers, the /ultracode + contract-gate
 * status widgets, and the toggle-command parser. The router brain behind the activate hooks.
 *
 * All functions take pi/ctx as parameters and hold no module state, so index.ts imports the
 * entry points back (used only inside the activate body and handlers) and re-exports
 * extractUltracodeTask for the composition test. Extracted byte-identically.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatWorkflowCompositionPromptSummary, formatWorkflowPatternKeyList } from "./templates.js";

const ULTRACODE_STATUS_KEY = "dynamic-workflows-ultracode";
const ULTRACODE_CONTRACT_STATUS_KEY = "dynamic-workflows-ultracode-contract";

function formatUltracodeContractGatePrompt(taskLabel = "Ultracode tasks"): string {
	return `Contract Gate

- For substantive ${taskLabel} that survive the trivial gate, run a small read-only task-contract review workflow before normal scout/orchestration.
- If ambiguity blocks even the task contract, ask only blocking questions; otherwise let the workflow infer safe assumptions and non-goals.
- Keep it cheap and inspectable: 3-4 independent contract reviewers plus synthesis, explicit concurrency/maxAgents, artifacts under the run directory, and no file edits.
- Required synthesis fields: improvedTask, successCriteria, assumptions, nonGoals, routingHints, verificationPlan, blockers.
- Use the improved task for the routing/scouting decision and mention whether the Contract Gate ran, was skipped as trivial, or was blocked.`;
}

function formatUltracodeRoutingRules(style: "command" | "always-on"): string {
	const trivialGate =
		style === "command"
			? "solve conversational, single-step, or few-tool-call tasks directly; do not build a workflow"
			: "conversational, single-step, or few-tool-call tasks stay single-agent";
	const scoutGate =
		style === "command"
			? "if the task may be broad, probe cheaply inline to discover the real work-list"
			: "broad-looking tasks get a cheap inline probe first (git ls-files, diff, rg/glob)";
	const orchestrateGate =
		style === "command"
			? "use a workflow only for exhaustiveness, confidence, or scale"
			: "use dynamic_workflow only for exhaustiveness, confidence, or scale";
	const catalogLine =
		style === "command"
			? "Inspect the template catalog before writing code.\n- Reuse an existing workflow only on an exact task match; otherwise write a gitignored .pi/workflows/drafts/<slug>.js draft."
			: "Inspect the catalog, then reuse an exact existing fit or write a gitignored .pi/workflows/drafts/<slug>.js draft.";
	const launchLine =
		style === "command"
			? "Graph/start background runs with explicit concurrency/maxAgents, then inspect artifacts."
			: "Graph/start in background with explicit concurrency/maxAgents, then inspect artifacts.";
	const scaleLine =
		style === "command"
			? "Scale concurrency/maxAgents to the discovered work-list and risk; log caps, clamps, skipped work, and failures."
			: "Scale parallelism to the work-list and risk; log caps, clamps, skipped work, and failed branches.";
	const commandWorkflowPath = `- ${catalogLine}
- ${launchLine}
- Use workflow-factory only when a warranted workflow needs complex prompt/contract design.
- ${scaleLine}
- For audits/research, keep subagents read-only and synthesize only evidence-backed findings.`;
	const alwaysOnWorkflowPath = `- ${catalogLine}
- ${launchLine}
- ${scaleLine}
- Use workflow-factory only when a warranted workflow needs complex prompt/contract design.`;
	return `Decision gates:
- Ambiguity: if it blocks routing or implementation, infer concise success criteria when safe; ask only blocking questions.
- Trivial: ${trivialGate}.
- Scout: ${scoutGate}.
- Orchestrate: ${orchestrateGate}.

Workflow path:
${style === "command" ? commandWorkflowPath : alwaysOnWorkflowPath}
- When drafting workflow code, remember subagents get web_search via pi-codex-web-search and context7-cli when installed; do not opt out unless the task requires isolation.

Reference:
- ${formatWorkflowPatternKeyList()}
- ${formatWorkflowCompositionPromptSummary()}`;
}

export function makeUltracodePrompt(
	task: string,
	mode: "ultracode" | "deep-research" = "ultracode",
	contractGateEnabled = true,
): string {
	const trimmed = task.trim();
	const header =
		mode === "deep-research"
			? "Use Pi Dynamic Workflows for a source-backed deep-research investigation."
			: "Use Pi Dynamic Workflows when they are warranted for this task.";
	const contractGate = contractGateEnabled
		? `\n\n${formatUltracodeContractGatePrompt(mode === "deep-research" ? "deep-research tasks" : "Ultracode tasks")}`
		: "";
	return `${header}

Task:
${trimmed}${contractGate}

Ultracode rules:

${formatUltracodeRoutingRules("command")}`;
}

export function makeAlwaysOnUltracodeSystemPrompt(contractGateEnabled = true): string {
	const contractGate = contractGateEnabled ? `\n\n${formatUltracodeContractGatePrompt("tasks")}` : "";
	return `## Always-on Ultracode Router

For substantive tasks, choose the lightest path that can verify the answer.${contractGate}

${formatUltracodeRoutingRules("always-on")}

Mention routing only when it affects plan, cost, latency, or user expectations.`;
}

export function dynamicWorkflowToolAvailable(selectedTools: string[] | undefined): boolean {
	return selectedTools?.includes("dynamic_workflow") ?? false;
}

export function ensureDynamicWorkflowToolActive(pi: ExtensionAPI): boolean {
	try {
		const active = pi.getActiveTools?.();
		if (!Array.isArray(active)) return false;
		if (active.includes("dynamic_workflow")) return true;
		const exists = pi.getAllTools?.().some((tool) => tool.name === "dynamic_workflow") ?? false;
		if (!exists) return false;
		pi.setActiveTools([...new Set([...active, "dynamic_workflow"])]);
		return true;
	} catch {
		return false;
	}
}

export function setUltracodeStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(ULTRACODE_STATUS_KEY, enabled ? theme.fg("accent", "uc:auto") : theme.fg("dim", "uc:off"));
}

export function clearUltracodeStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(ULTRACODE_STATUS_KEY, undefined);
}

export function setUltracodeContractGateStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(ULTRACODE_CONTRACT_STATUS_KEY, enabled ? theme.fg("dim", "cg:on") : theme.fg("warning", "cg:off"));
}

export function clearUltracodeContractGateStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(ULTRACODE_CONTRACT_STATUS_KEY, undefined);
}

export function extractUltracodeTask(textValue: string): string | undefined {
	const trimmed = textValue.trim();
	// Separator after the keyword may be a `:`/`-` (with or without a trailing space) or just
	// whitespace, so `ultracode:do X`, `ultracode: do X`, and `ultracode do X` all parse.
	const match = /^(?:ultracode|dynamic\s+workflow)(?:\s*[:-]\s*|\s+)([\s\S]+)/i.exec(trimmed);
	return match?.[1]?.trim();
}

export function isGeneratedUltracodePrompt(prompt: string): boolean {
	return prompt.includes("\nUltracode rules:\n");
}

type ToggleCommandValue = "status" | "on" | "off" | "invalid";

export function parseToggleCommandValue(raw: string): ToggleCommandValue {
	const value = raw.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (["on", "enable", "enabled", "true", "1"].includes(value)) return "on";
	if (["off", "disable", "disabled", "false", "0"].includes(value)) return "off";
	return "invalid";
}

export function sendWorkflowPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}
