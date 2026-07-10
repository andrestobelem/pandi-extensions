/**
 * Construcción del workflow graph model desde introspección estática de fuente.
 * La expansión de sub-workflows requiere un resolver inyectado (sin importar surface).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition, WorkflowScopeInput } from "../../types.js";
import {
	extractDirectStringLiteralArgument,
	extractFirstStringLiteral,
	findCallEndIndex,
	formatWorkflowGraphFanoutSummary,
	graphTextLabel,
	inferWorkflowGraphFanout,
	isJavaScriptCodePosition,
	lineNumberAtIndex,
	splitTopLevelArguments,
	workflowGraphMethodInfo,
} from "./parse.js";
import type { WorkflowGraphCall, WorkflowGraphChildCall, WorkflowGraphModel, WorkflowGraphStep } from "./types.js";

export type ResolveWorkflowFn = (
	ctx: ExtensionContext,
	name: string,
	scope?: WorkflowScopeInput,
) => Promise<WorkflowDefinition>;

export function buildWorkflowGraphModel(workflow: WorkflowDefinition, code: string): WorkflowGraphModel {
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
		// Salta una bare `function <method>(…)` DECLARATION (p. ej. `async function workflow(ctx, input)`),
		// que es la entry function, no una composition call.
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
	workflow: WorkflowDefinition,
	code: string,
	resolveWorkflow: ResolveWorkflowFn,
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
				resolveWorkflow,
				depth + 1,
				nextSeen,
			);
		} catch (err) {
			step.subworkflowError = err instanceof Error ? err.message : String(err);
		}
	}
	return model;
}
