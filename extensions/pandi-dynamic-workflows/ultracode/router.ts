/**
 * Router de Ultracode — los builders always-on de prompts (reglas de routing, contract-gate,
 * prompt de sistema), los helpers de activación del tool dynamic-workflow, los widgets de status
 * /ultracode-mode + contract-gate y el parser del comando toggle. El cerebro router detrás de los hooks activate.
 *
 * Todas las funciones reciben pi/ctx como parámetros y no mantienen estado de módulo, así que index.ts importa de vuelta
 * los entry points (usados solo dentro del cuerpo activate y handlers) y reexporta
 * extractUltracodeTask para el test de composición. Extraído byte-idéntico.
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatWorkflowCompositionPromptSummary, formatWorkflowPatternKeyList } from "./pattern-scaffolds.js";

const ULTRACODE_STATUS_KEY = "dynamic-workflows-ultracode";
const ULTRACODE_CONTRACT_STATUS_KEY = "dynamic-workflows-ultracode-contract";

/** Opciones etiquetadas para humanos del selector `/ultracode-mode` bare (el primer token es el valor). */
const ULTRACODE_MODE_SELECT_ITEMS = [
	"on — route every task through the dynamic workflow router",
	"off — disable always-on routing for this session",
	"status — show the current always-on state",
];

/**
 * Resuelve el argumento de `/ultracode-mode`, abriendo un selector interactivo cuando el
 * comando se invoca bare en una sesión con UI. Headless (sin UI) y args explícitos
 * mantienen el comportamiento sin cambios (bare = "status"), así no hay regresiones off-TUI.
 */
export async function resolveUltracodeModeValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Ultracode always-on", ULTRACODE_MODE_SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "status";
}

function formatUltracodeContractGatePrompt(taskLabel = "Ultracode tasks"): string {
	return `Contract Gate

- For substantive ${taskLabel} that survive the trivial gate, run a small read-only task-contract review workflow: the canonical \`contract-gate\` scaffold workflow. \`dynamic_workflow action=scaffold name=contract-gate\` reads its source; \`read/check/run/start name=contract-gate\` use that same source without copying it.
- If ambiguity blocks even the task contract, ask only blocking questions; otherwise let the workflow infer safe assumptions and non-goals.
- Keep it cheap and inspectable: 3-4 independent contract reviewers plus synthesis, explicit concurrency/maxAgents, artifacts under the run directory, and no file edits.
- Required result fields: status, verdict, contract (including improvedTask, successCriteria, assumptions, nonGoals, constraints and verificationPlan), rewrittenPrompt, routing; include questions only when blocked.
- Use the improved task for the routing/scouting decision and mention whether the Contract Gate ran, was skipped as trivial, or was blocked.`;
}

function formatOptionalContractGatePrompt(taskLabel: string, contractGateEnabled: boolean): string {
	return contractGateEnabled ? `\n\n${formatUltracodeContractGatePrompt(taskLabel)}` : "";
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
			? `Inspect the scaffold catalog before writing code.\n- Reuse an existing workflow only on an exact task match; otherwise write a gitignored ${CONFIG_DIR_NAME}/workflows/drafts/<slug>.js draft.`
			: `Inspect the catalog, then reuse an exact existing fit or write a gitignored ${CONFIG_DIR_NAME}/workflows/drafts/<slug>.js draft.`;
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
	const contractGate = formatOptionalContractGatePrompt(
		mode === "deep-research" ? "deep-research tasks" : "Ultracode tasks",
		contractGateEnabled,
	);
	return `${header}

Task:
${trimmed}${contractGate}

Ultracode rules:

${formatUltracodeRoutingRules("command")}`;
}

export function makeAlwaysOnUltracodeSystemPrompt(contractGateEnabled = true): string {
	const contractGate = formatOptionalContractGatePrompt("tasks", contractGateEnabled);
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
	// El separador después de la keyword puede ser `:`/`-` (con o sin espacio posterior) o solo
	// whitespace, así `ultracode:do X`, `ultracode: do X` y `ultracode do X` parsean todos.
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
