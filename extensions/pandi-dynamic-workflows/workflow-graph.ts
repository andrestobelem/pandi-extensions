/**
 * Workflow-graph render + image kernel for pandi-dynamic-workflows.
 *
 * Builds the workflow graph model from a parsed workflow (static JS introspection),
 * renders it as Markdown/overview/mermaid lines, and renders a PNG via the mermaid
 * CLI (mmdc). Consumes the graph-parse sibling for source-introspection helpers and
 * the process-spawn sibling (runProcess) for the mmdc subprocess. The WorkflowGraph
 * model types live in index.ts (shared with the WorkflowGraphComponent TUI) and are
 * imported here as types; WorkflowGraphImageRender/Attempt are owned here.
 *
 * Deferred cycle with index.ts: resolveWorkflow is read only inside bodies; the model
 * types cross as import type (erased). index.ts imports the externally-consumed
 * functions back and WorkflowGraphImageAttempt as a type.
 */
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, truncateToWidth } from "@earendil-works/pi-tui";
import {
	extractDirectStringLiteralArgument,
	extractFirstStringLiteral,
	findCallEndIndex,
	formatWorkflowGraphFanoutSummary,
	graphTextLabel,
	inferWorkflowGraphFanout,
	isJavaScriptCodePosition,
	lineNumberAtIndex,
	mermaidLabel,
	splitTopLevelArguments,
	summarizeWorkflowGraphChildren,
	workflowGraphMethodInfo,
} from "./graph-parse.js";
import type { WorkflowFile } from "./index.js";
import { EXTENSION_ROOT } from "./index.js";
import { notify } from "./notify.js";
import type { ProcessResult } from "./process-spawn.js";
import { runProcess } from "./process-spawn.js";
import { padRightVisible } from "./render-utils.js";
import { WorkflowGraphComponent } from "./workflow-graph-component.js";
import { ensureDir, getGraphRoot, resolveWorkflow, slugify } from "./workflow-resolve.js";

function buildWorkflowGraphModel(workflow: WorkflowFile, code: string): WorkflowGraphModel {
	// Detect BOTH authoring styles the runtime supports: the ctx-legacy form (`ctx.agents(...)`) and
	// the globals form (bare `agents(...)`, no ctx.*). `(?<![\w.])` rejects a method glued to another
	// identifier or a property access on a different object (`fs.readFile`, `myagents(`); the optional
	// `(ctx\.)` capture records which style was used so labels are not mislabeled.
	const regex =
		/(?<![\w.])(ctx\.)?(parallel|pipeline|agents|agent|workflow|bash|writeArtifact|appendArtifact|readFile|writeFile|appendFile|listFiles)\s*\(/g;
	const calls: WorkflowGraphCall[] = [];
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec() loop
	while ((match = regex.exec(code)) !== null) {
		if (!isJavaScriptCodePosition(code, match.index)) continue;
		const prefix = match[1] ? "ctx." : "";
		const method = match[2];
		// Skip a bare `function <method>(…)` DECLARATION (e.g. `async function workflow(ctx, input)`),
		// which is the entry function, not a composition call.
		if (!prefix && /\bfunction\*?\s*$/.test(code.slice(0, match.index))) continue;
		const openParenIndex = regex.lastIndex - 1;
		const end = findCallEndIndex(code, openParenIndex);
		const snippet = code.slice(openParenIndex + 1, Math.max(openParenIndex + 1, end - 1));
		const args = splitTopLevelArguments(snippet);
		const firstArg =
			method === "workflow" ? extractDirectStringLiteralArgument(args[0] ?? "") : extractFirstStringLiteral(snippet);
		const info = workflowGraphMethodInfo(method);
		calls.push({
			...info,
			prefix,
			start: match.index,
			end,
			snippet,
			line: lineNumberAtIndex(code, match.index),
			label: `${info.title}${firstArg ? `: ${graphTextLabel(firstArg)}` : ""}`,
			...(firstArg ? { firstArg: graphTextLabel(firstArg) } : {}),
		});
	}

	const orchestrationParents = new Set(["agents", "parallel", "pipeline"]);
	const childrenByParent = new Map<WorkflowGraphCall, WorkflowGraphChildCall[]>();
	const topLevelCalls: WorkflowGraphCall[] = [];
	for (const call of calls) {
		let parent: WorkflowGraphCall | undefined;
		for (const candidate of calls) {
			if (candidate === call || !orchestrationParents.has(candidate.method)) continue;
			if (candidate.start < call.start && call.end <= candidate.end && (!parent || candidate.start > parent.start))
				parent = candidate;
		}
		if (parent) {
			const children = childrenByParent.get(parent) ?? [];
			children.push(call);
			childrenByParent.set(parent, children);
		} else {
			topLevelCalls.push(call);
		}
	}

	const steps: WorkflowGraphStep[] = [];
	let agentPhaseIndex = 0;
	for (const call of topLevelCalls) {
		const args = splitTopLevelArguments(call.snippet);
		const phaseIndex = call.method === "agents" ? ++agentPhaseIndex : undefined;
		const fanout = inferWorkflowGraphFanout(call.method, args, phaseIndex);
		const children = childrenByParent.get(call) ?? [];
		steps.push({
			method: call.method,
			prefix: call.prefix,
			kind: call.kind,
			symbol: call.symbol,
			title: call.title,
			index: steps.length + 1,
			line: call.line,
			label: fanout ? `${call.title} (${formatWorkflowGraphFanoutSummary(fanout)})` : call.label,
			...(call.firstArg ? { firstArg: call.firstArg } : {}),
			children,
			...(fanout ? { fanout } : {}),
		});
	}

	const notes = [
		"Static preview inferred from source-order global calls (agent/agents/parallel/pipeline/workflow); runtime data can differ.",
		"Fan-out counts are static expressions; /workflow view shows runtime P1 i/n totals.",
		"Does not evaluate budget, retries, cache hits, or error paths.",
	];
	if (steps.some((step) => step.children.length > 0))
		notes.push("Nested calls inside pipeline/parallel/agents are grouped under their orchestration step.");
	if (/\b(for|while)\s*\(/.test(code)) notes.push("Loops detected; repeated calls are shown once in source order.");
	if (/\bif\s*\(|\?[^\n]+:/.test(code)) notes.push("Branches detected; conditional paths are approximate.");
	return { workflow, steps, notes };
}

export async function buildWorkflowGraphModelWithSubworkflows(
	ctx: ExtensionContext,
	workflow: WorkflowFile,
	code: string,
	depth = 0,
	seen = new Set<string>(),
): Promise<WorkflowGraphModel> {
	const model = buildWorkflowGraphModel(workflow, code);
	const currentPath = path.resolve(workflow.path);
	const nextSeen = new Set(seen);
	nextSeen.add(currentPath);
	const subworkflowSteps = model.steps.filter((step) => step.kind === "subworkflow");
	if (subworkflowSteps.length > 0) {
		model.notes.push(
			"workflow() calls with literal names are expanded one level using the referenced workflow file; dynamic names are shown but not resolved.",
		);
	}
	for (const step of subworkflowSteps) {
		if (!step.firstArg) {
			step.subworkflowError = "dynamic sub-workflow name; cannot resolve statically";
			continue;
		}
		if (depth >= 1) {
			step.subworkflowError = "nested sub-workflows are not expanded; runtime composition depth limit is 1";
			continue;
		}
		try {
			const subWorkflow = await resolveWorkflow(ctx, step.firstArg, "auto");
			const subPath = path.resolve(subWorkflow.path);
			if (nextSeen.has(subPath)) {
				step.subworkflowError = `recursive sub-workflow skipped: ${subWorkflow.name}`;
				continue;
			}
			const subCode = await fs.readFile(subWorkflow.path, "utf8");
			step.subworkflow = await buildWorkflowGraphModelWithSubworkflows(
				ctx,
				subWorkflow,
				subCode,
				depth + 1,
				nextSeen,
			);
		} catch (err) {
			step.subworkflowError = err instanceof Error ? err.message : String(err);
		}
	}
	return model;
}

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

function workflowGraphSingularUnit(unit: WorkflowGraphFanoutUnit): string {
	if (unit === "agents") return "agent";
	if (unit === "branches") return "branch";
	return "lane";
}

function workflowGraphVisibleFanoutSlots(fanout: WorkflowGraphFanoutInfo): string[] {
	const unit = workflowGraphSingularUnit(fanout.unit);
	if (fanout.count !== undefined) {
		if (fanout.count <= 0) return [`no ${fanout.unit}`];
		if (fanout.count <= 6) return Array.from({ length: fanout.count }, (_, index) => `${unit} ${index + 1}`);
		return [`${unit} 1`, `${unit} 2`, `${unit} 3`, "…", `${unit} ${fanout.count}`];
	}
	return [`${unit} 1`, `${unit} 2`, "…", `${unit} n`];
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

function renderWorkflowGraphMermaidLines(model: WorkflowGraphModel): string[] {
	const lines = ["flowchart TD", `  start([${mermaidLabel(model.workflow.name)}])`];
	if (model.steps.length === 0) {
		lines.push("  start --> done([done])");
		return lines;
	}
	const exit = appendWorkflowGraphMermaidSteps(lines, model, "start", "", "  ");
	lines.push(`  ${exit} --> done([done])`);
	return lines;
}

export interface WorkflowGraphImageRender {
	base64: string;
	pngPath: string;
	mmdPath: string;
	command: string;
	elapsedMs: number;
	width: number;
	height: number;
	scale: number;
}

export interface WorkflowGraphImageAttempt {
	image?: WorkflowGraphImageRender;
	warning?: string;
}

function displayPathFromCwd(cwd: string, file: string): string {
	const relative = path.relative(cwd, file).replaceAll(path.sep, "/");
	return relative && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative) ? relative : file;
}

function clampWorkflowGraphNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function workflowGraphStats(model: WorkflowGraphModel): {
	steps: number;
	fanoutSlots: number;
	orchestrationGroups: number;
	subworkflows: number;
} {
	let steps = model.steps.length;
	let fanoutSlots = 0;
	let orchestrationGroups = 0;
	let subworkflows = 0;
	for (const step of model.steps) {
		if (step.fanout) {
			fanoutSlots += workflowGraphVisibleFanoutSlots(step.fanout).length;
			orchestrationGroups++;
		}
		if (step.subworkflow) {
			subworkflows++;
			const child = workflowGraphStats(step.subworkflow);
			steps += child.steps;
			fanoutSlots += child.fanoutSlots;
			orchestrationGroups += child.orchestrationGroups;
			subworkflows += child.subworkflows;
		}
	}
	return { steps, fanoutSlots, orchestrationGroups, subworkflows };
}

export function workflowGraphImageOptions(model: WorkflowGraphModel): {
	width: number;
	height: number;
	scale: number;
	maxWidthCells: number;
	maxHeightCells: number;
} {
	const stats = workflowGraphStats(model);
	return {
		width: clampWorkflowGraphNumber(2200 + stats.fanoutSlots * 120 + stats.subworkflows * 220, 2200, 3800),
		height: clampWorkflowGraphNumber(
			1300 + stats.steps * 130 + stats.orchestrationGroups * 180 + stats.subworkflows * 220,
			1300,
			3200,
		),
		scale: 2,
		maxWidthCells: 320,
		maxHeightCells: clampWorkflowGraphNumber(
			54 + stats.orchestrationGroups * 8 + stats.subworkflows * 8 + Math.floor(stats.steps / 2),
			54,
			96,
		),
	};
}

function mmdcBinName(): string {
	return process.platform === "win32" ? "mmdc.cmd" : "mmdc";
}

function resolveMmdcInvocation(cwd: string): {
	command: string;
	argsPrefix: string[];
	display: string;
} {
	const bin = mmdcBinName();
	const candidates = [
		path.join(cwd, "node_modules", ".bin", bin),
		path.join(process.cwd(), "node_modules", ".bin", bin),
		path.join(EXTENSION_ROOT, "node_modules", ".bin", bin),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate))
			return { command: candidate, argsPrefix: [], display: displayPathFromCwd(cwd, candidate) };
	}
	return { command: "mmdc", argsPrefix: [], display: "mmdc" };
}

function formatMmdcFailure(command: string, result: ProcessResult): string {
	const details = [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").trim();
	const hint = /Could not find Chrome|Chrome.*not found|browser/i.test(details)
		? "\nHint: run `npx puppeteer browsers install chrome-headless-shell` if the Puppeteer browser was not installed."
		: "";
	const code = result.code === null ? "spawn" : `exit ${result.code}`;
	return `mmdc failed (${code}) via ${command}.${hint}${details ? `\n${details}` : ""}`;
}

export async function renderWorkflowGraphImage(
	ctx: ExtensionContext,
	model: WorkflowGraphModel,
): Promise<WorkflowGraphImageAttempt> {
	if (!getCapabilities().images)
		return {
			warning: "Terminal image protocol is not available, so inline PNG rendering is disabled.",
		};
	const root = getGraphRoot(ctx);
	await ensureDir(root);
	const base = `${slugify(model.workflow.name)}-${crypto.createHash("sha1").update(model.workflow.path).digest("hex").slice(0, 8)}`;
	const mmdPath = path.join(root, `${base}.mmd`);
	const pngPath = path.join(root, `${base}.png`);
	await fs.writeFile(mmdPath, `${renderWorkflowGraphMermaidLines(model).join("\n")}\n`, "utf8");

	const invocation = resolveMmdcInvocation(ctx.cwd);
	const imageOptions = workflowGraphImageOptions(model);
	const args = [
		...invocation.argsPrefix,
		"-q",
		"-i",
		mmdPath,
		"-o",
		pngPath,
		"-e",
		"png",
		"-t",
		"dark",
		"-b",
		"transparent",
		"-w",
		String(imageOptions.width),
		"-H",
		String(imageOptions.height),
		"-s",
		String(imageOptions.scale),
	];
	const started = Date.now();
	const result = await runProcess(invocation.command, args, { cwd: ctx.cwd, timeoutMs: 60_000 });
	if (!result.ok) return { warning: formatMmdcFailure(invocation.display, result) };
	try {
		const base64 = await fs.readFile(pngPath, "base64");
		return {
			image: {
				base64,
				pngPath,
				mmdPath,
				command: invocation.display,
				elapsedMs: Date.now() - started,
				width: imageOptions.width,
				height: imageOptions.height,
				scale: imageOptions.scale,
			},
		};
	} catch (err) {
		return {
			warning: `mmdc reported success but the PNG could not be read: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
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
	workflow: WorkflowFile,
	code: string,
): Promise<string> {
	return renderWorkflowGraphDocumentLines(
		await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code),
		120,
	).join("\n");
}

/**
 * Workflow graph model types + the showWorkflowGraph view opener, consolidated here with the
 * graph builders/renderers that own them. graph-parse.js and workflow-graph-component.js
 * import these types from here; command handlers open the view via showWorkflowGraph.
 * Deferred cycle with workflow-graph-component.js (WorkflowGraphComponent used only inside
 * showWorkflowGraph's body). Moved byte-identically from index.ts.
 */
type WorkflowGraphStepKind =
	| "agent"
	| "artifact"
	| "barrier"
	| "fanout"
	| "file"
	| "pipeline"
	| "shell"
	| "subworkflow";

export type WorkflowGraphFanoutUnit = "agents" | "branches" | "lanes";

export interface WorkflowGraphFanoutInfo {
	unit: WorkflowGraphFanoutUnit;
	countLabel: string;
	count?: number;
	many: boolean;
	phaseLabel?: string;
	concurrency?: string;
	settle?: boolean;
	stages?: number;
}

export interface WorkflowGraphChildCall {
	method: string;
	/** Call-syntax prefix used in source: "ctx." for ctx-legacy calls, "" for globals-style. */
	prefix?: string;
	kind: WorkflowGraphStepKind;
	symbol: string;
	title: string;
	label: string;
	line: number;
	firstArg?: string;
}

export interface WorkflowGraphStep {
	index: number;
	method: string;
	/** Call-syntax prefix used in source: "ctx." for ctx-legacy calls, "" for globals-style. */
	prefix?: string;
	kind: WorkflowGraphStepKind;
	symbol: string;
	title: string;
	label: string;
	line: number;
	firstArg?: string;
	children: WorkflowGraphChildCall[];
	fanout?: WorkflowGraphFanoutInfo;
	subworkflow?: WorkflowGraphModel;
	subworkflowError?: string;
}

export interface WorkflowGraphCall extends WorkflowGraphChildCall {
	start: number;
	end: number;
	snippet: string;
}

export interface WorkflowGraphModel {
	workflow: WorkflowFile;
	steps: WorkflowGraphStep[];
	notes: string[];
}

export interface WorkflowGraphRenderTheme {
	accent(text: string): string;
	muted(text: string): string;
	success(text: string): string;
	warning(text: string): string;
}

export async function showWorkflowGraph(ctx: ExtensionContext, workflow: WorkflowFile, code: string): Promise<void> {
	const model = await buildWorkflowGraphModelWithSubworkflows(ctx, workflow, code);
	if (ctx.mode === "print") {
		console.log(renderWorkflowGraphDocumentLines(model, 120).join("\n"));
		return;
	}
	if (ctx.mode === "tui") {
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
