/**
 * Render TUI/document/Mermaid del workflow graph model.
 * showWorkflowGraph importa renderWorkflowGraphImage dinámicamente para evitar ciclo con workflow-graph-image.js.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { notify } from "../../notify.js";
import type { WorkflowDefinition } from "../../types.js";
import { padRightVisible } from "../render-utils.js";
import { WorkflowGraphComponent } from "./component.js";
import { workflowGraphStats, workflowGraphVisibleFanoutSlots } from "./image.js";
import { buildWorkflowGraphModelWithSubworkflows } from "./model.js";
import {
	formatWorkflowGraphFanoutSummary,
	graphTextLabel,
	mermaidLabel,
	summarizeWorkflowGraphChildren,
} from "./parse.js";
import type { WorkflowGraphModel, WorkflowGraphRenderTheme, WorkflowGraphStep } from "./types.js";

function renderWorkflowGraphStepDetail(step: WorkflowGraphStep): string[] {
	const lines: string[] = [];
	if (step.fanout) {
		lines.push(`visual: ${formatWorkflowGraphFanoutSummary(step.fanout)}`);
		if (step.fanout.many)
			lines.push("diagram: fork → visible workers/lanes → join, with … when the count is large or dynamic");
	}
	if (step.kind === "fanout")
		lines.push(
			"branches: one Pi subagent per item/spec",
			"join: results array; failed branches may be null with settle:true",
		);
	else if (step.kind === "barrier")
		lines.push("branches: async thunks run concurrently", "join: barrier waits for every branch before continuing");
	else if (step.kind === "pipeline")
		lines.push("lanes: each item flows through stages", "join: returned array preserves item order");
	else if (step.kind === "subworkflow") {
		lines.push("delegates to another workflow and returns to this flow");
		if (step.subworkflow)
			lines.push(`expands: ${step.subworkflow.workflow.name} (${step.subworkflow.steps.length} steps)`);
		else if (step.subworkflowError) lines.push(`subgraph unavailable: ${step.subworkflowError}`);
	} else if (step.kind === "agent") lines.push("single Pi subagent call");
	else if (step.kind === "shell") lines.push("host shell command from workflow cwd");
	else if (step.kind === "artifact") lines.push("persists run evidence outside chat context");
	else lines.push("file helper inside workflow cwd");
	const childSummary = summarizeWorkflowGraphChildren(step.children);
	if (childSummary) lines.push(`inside: ${childSummary}`);
	return lines;
}

function workflowGraphStyles(theme?: any): WorkflowGraphRenderTheme {
	return {
		accent: (text: string) => (theme ? theme.fg("accent", text) : text),
		muted: (text: string) => (theme ? theme.fg("muted", text) : text),
		success: (text: string) => (theme ? theme.fg("success", text) : text),
		warning: (text: string) => (theme ? theme.fg("warning", text) : text),
	};
}

function renderWorkflowGraphSubworkflowSummaryLines(model: WorkflowGraphModel, depth = 1): string[] {
	const indent = "  ".repeat(depth);
	const lines = [`${indent}↳ sub-workflow graph: ${model.workflow.name} (${model.steps.length} steps)`];
	for (const step of model.steps.slice(0, 12)) {
		lines.push(`${indent}  ${step.symbol} ${step.label} L${step.line} ${step.prefix ?? "ctx."}${step.method}`);
		if (step.subworkflow) lines.push(...renderWorkflowGraphSubworkflowSummaryLines(step.subworkflow, depth + 2));
		else if (step.subworkflowError) lines.push(`${indent}    ↳ subgraph unavailable: ${step.subworkflowError}`);
	}
	if (model.steps.length > 12) lines.push(`${indent}  … ${model.steps.length - 12} more steps`);
	return lines;
}

function renderWorkflowGraphOverviewLines(model: WorkflowGraphModel, width: number, theme?: any): string[] {
	if (width <= 0) return [];
	const w = width;
	const style = workflowGraphStyles(theme);
	const line = (textValue: string) => truncateToWidth(textValue, w, "");
	const steps = model.steps;
	const stats = workflowGraphStats(model);
	const fanoutCount = steps.filter(
		(step) => step.kind === "fanout" || step.kind === "barrier" || step.kind === "pipeline",
	).length;
	const ioCount = steps.filter(
		(step) => step.kind === "artifact" || step.kind === "file" || step.kind === "shell",
	).length;
	const lines: string[] = [
		line(`${style.accent("Workflow topology")} ${style.muted("static preview")}`),
		line(`${style.muted("name:")} ${model.workflow.name}`),
		line(`${style.muted("file:")} ${model.workflow.relativePath}`),
		line(
			`${style.muted("steps:")} ${steps.length}${stats.steps !== steps.length ? ` (${stats.steps} incl. sub-workflows)` : ""} ${style.muted("• orchestration:")} ${fanoutCount} ${style.muted("• I/O:")} ${ioCount}${stats.subworkflows ? ` ${style.muted("• sub-workflows:")} ${stats.subworkflows}` : ""}`,
		),
		line(
			`${style.muted("legend:")} ${style.accent("◆ fan-out ×N")} ${style.muted("|")} ${style.accent("⧉ barrier branches")} ${style.muted("|")} ${style.accent("▣ pipeline lanes")} ${style.muted("|")} ${style.accent("● agent")} ${style.muted("|")} ${style.accent("$ bash")} ${style.muted("|")} ${style.accent("▤ artifact")}`,
		),
		line(""),
		line(style.accent("Topology")),
	];

	if (steps.length === 0) {
		lines.push(line(`  ${style.warning("No workflow API calls detected.")}`));
		lines.push(
			line(`  ${style.muted("This may be a trivial workflow or the graph heuristic missed dynamic indirection.")}`),
		);
	} else {
		lines.push(line(`  ${style.success("start")} ${style.muted("→")} ${graphTextLabel(model.workflow.name)}`));
		for (const step of steps) {
			lines.push(line(`    ${style.muted("│")}`));
			lines.push(
				line(
					`    ${style.accent(step.symbol)} ${step.label} ${style.muted(`L${step.line} ${step.prefix ?? "ctx."}${step.method}`)}`,
				),
			);
			for (const detail of renderWorkflowGraphStepDetail(step)) {
				lines.push(line(`    ${style.muted("│")} ${style.muted(detail)}`));
			}
			if (step.subworkflow) {
				for (const subLine of renderWorkflowGraphSubworkflowSummaryLines(step.subworkflow)) {
					lines.push(line(`    ${style.muted("│")} ${style.muted(subLine)}`));
				}
			}
		}
		lines.push(line(`    ${style.muted("│")}`));
		lines.push(line(`  ${style.success("done")}`));
	}

	lines.push(line(""));
	lines.push(line(style.accent("Detected calls")));
	if (steps.length === 0) {
		lines.push(line(style.muted("No calls to list.")));
	} else {
		for (const step of steps) {
			const index = padRightVisible(`${step.index}.`, 4);
			lines.push(
				line(
					`${style.muted(index)}${style.accent(step.symbol)} ${step.label} ${style.muted(`— L${step.line}, ${step.prefix ?? "ctx."}${step.method}`)}`,
				),
			);
			for (const child of step.children) {
				lines.push(
					line(
						`${style.muted("    ↳")} ${style.accent(child.symbol)} ${child.label} ${style.muted(`— L${child.line}, nested ${child.prefix ?? "ctx."}${child.method}`)}`,
					),
				);
			}
			if (step.subworkflow) {
				for (const subLine of renderWorkflowGraphSubworkflowSummaryLines(step.subworkflow))
					lines.push(line(style.muted(`    ${subLine}`)));
			}
		}
	}

	lines.push(line(""));
	lines.push(line(style.accent("Limitations")));
	for (const note of model.notes) lines.push(line(`${style.muted("•")} ${style.muted(note)}`));
	return lines;
}

function appendWorkflowGraphMermaidSteps(
	lines: string[],
	model: WorkflowGraphModel,
	previousExit: string,
	prefix: string,
	indent: string,
): string {
	let currentExit = previousExit;
	for (const step of model.steps) {
		const id = `${prefix}s${step.index}`;
		const label = mermaidLabel(`${step.symbol} ${step.label}`);
		if (step.kind === "subworkflow" && step.subworkflow) {
			const groupId = `${prefix}g${step.index}_sub`;
			const subStartId = `${id}_start`;
			const subDoneId = `${id}_return`;
			lines.push(`${indent}subgraph ${groupId}["${label}"]`);
			lines.push(`${indent}  direction TD`);
			lines.push(`${indent}  ${subStartId}([${mermaidLabel(step.subworkflow.workflow.name)}])`);
			const subExit = appendWorkflowGraphMermaidSteps(
				lines,
				step.subworkflow,
				subStartId,
				`${prefix}s${step.index}_`,
				`${indent}  `,
			);
			lines.push(`${indent}  ${subExit} --> ${subDoneId}([return])`);
			lines.push(`${indent}end`);
			lines.push(`${indent}${currentExit} --> ${groupId}`);
			currentExit = groupId;
			continue;
		}
		if (step.fanout) {
			const groupId = `${prefix}g${step.index}`;
			const entryId = `${id}_in`;
			const exitId = `${id}_out`;
			const entryLabel = step.kind === "pipeline" ? "items" : "fork";
			const exitLabel = step.kind === "barrier" ? "barrier" : "join";
			lines.push(`${indent}subgraph ${groupId}["${label}"]`);
			lines.push(`${indent}  direction LR`);
			lines.push(`${indent}  ${entryId}((${mermaidLabel(entryLabel)}))`);
			lines.push(`${indent}  ${exitId}((${mermaidLabel(exitLabel)}))`);
			const slots = workflowGraphVisibleFanoutSlots(step.fanout);
			for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
				const workerId = `${id}_w${slotIndex + 1}`;
				const workerLabel =
					step.fanout.unit === "lanes" && step.fanout.stages !== undefined
						? `${slots[slotIndex]} · ${step.fanout.stages} stages`
						: slots[slotIndex];
				lines.push(`${indent}  ${workerId}["${mermaidLabel(workerLabel)}"]`);
				lines.push(`${indent}  ${entryId} --> ${workerId}`);
				lines.push(`${indent}  ${workerId} --> ${exitId}`);
			}
			lines.push(`${indent}end`);
			lines.push(`${indent}${currentExit} --> ${groupId}`);
			currentExit = groupId;
			continue;
		}
		const unavailable = step.kind === "subworkflow" && step.subworkflowError ? ` · ${step.subworkflowError}` : "";
		const shape =
			step.kind === "fanout" || step.kind === "barrier" || step.kind === "pipeline"
				? `{{${label}}}`
				: `["${mermaidLabel(`${step.symbol} ${step.label}${unavailable}`)}"]`;
		lines.push(`${indent}${id}${shape}`);
		lines.push(`${indent}${currentExit} --> ${id}`);
		currentExit = id;
	}
	return currentExit;
}

export function renderWorkflowGraphMermaidLines(model: WorkflowGraphModel): string[] {
	const lines = ["flowchart TD", `  start([${mermaidLabel(model.workflow.name)}])`];
	if (model.steps.length === 0) {
		lines.push("  start --> done([done])");
		return lines;
	}
	const exit = appendWorkflowGraphMermaidSteps(lines, model, "start", "", "  ");
	lines.push(`  ${exit} --> done([done])`);
	return lines;
}

export function renderWorkflowGraphDocumentLines(model: WorkflowGraphModel, width: number, theme?: any): string[] {
	if (width <= 0) return [];
	const style = workflowGraphStyles(theme);
	const line = (textValue: string) => truncateToWidth(textValue, width, "");
	const lines = renderWorkflowGraphOverviewLines(model, width, theme);
	lines.push(line(""));
	lines.push(line(style.accent("Mermaid export")));
	lines.push(line(style.muted("Copyable fallback for tools/docs that can render Mermaid.")));
	lines.push(line("```mermaid"));
	for (const mermaidLine of renderWorkflowGraphMermaidLines(model)) lines.push(line(mermaidLine));
	lines.push(line("```"));
	return lines;
}

export async function makeWorkflowGraphForContext(
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	code: string,
): Promise<string> {
	return renderWorkflowGraphDocumentLines(
		await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code),
		120,
	).join("\n");
}

/**
 * showWorkflowGraph view opener. Deferred cycle with workflow-graph-component.js
 * (WorkflowGraphComponent used only inside showWorkflowGraph's body).
 */
export async function showWorkflowGraph(
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	code: string,
): Promise<void> {
	const model = await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code);
	if (ctx.mode === "print") {
		console.log(renderWorkflowGraphDocumentLines(model, 120).join("\n"));
		return;
	}
	if (ctx.mode === "tui") {
		const { renderWorkflowGraphImage } = await import("./image.js");
		const imageAttempt = await renderWorkflowGraphImage(ctx, model).catch((err) => ({
			warning: err instanceof Error ? err.message : String(err),
		}));
		await ctx.ui.custom<void>(
			(_tui, theme, _keybindings, done) =>
				new WorkflowGraphComponent(model, theme, () => done(undefined), imageAttempt),
		);
		return;
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(`Workflow graph: ${workflow.name}`, renderWorkflowGraphDocumentLines(model, 120).join("\n"));
		return;
	}
	notify(ctx, renderWorkflowGraphDocumentLines(model, 100).join("\n"), "info");
}
