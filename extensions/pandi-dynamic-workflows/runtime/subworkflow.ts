import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeCodeHash } from "../lib/code-hash.js";
import { throwIfAborted } from "../lib/concurrency.js";
import type { ResolveWorkflowFn } from "../lib/graph/index.js";
import type { OccurrenceCounter } from "../lib/occurrence-counter.js";
import type { RunLimits, WorkflowDefinition } from "../types.js";
import type { WorkflowRuntimeApi } from "./api.js";
import { computeCallKey } from "./journal.js";
import { executeWorkflowCode } from "./worker-bridge.js";

export type RunSubworkflowContext = {
	ctx: ExtensionContext;
	resolveWorkflow: ResolveWorkflowFn;
	parentWorkflowDefinition: WorkflowDefinition;
	runSignal: { signal: AbortSignal };
	runLimits: Readonly<RunLimits>;
	occurrences: OccurrenceCounter;
	getAgentCount: () => number;
	appendEvent: (event: unknown) => Promise<void>;
	log: (message: string, details?: unknown) => Promise<void>;
	makeApi: (workflowNamespace: string | undefined, allowWorkflow: boolean, apiInput: unknown) => WorkflowRuntimeApi;
};

export async function runSubworkflow(
	host: RunSubworkflowContext,
	name: string,
	workflowInput: unknown = {},
): Promise<unknown> {
	const {
		ctx,
		resolveWorkflow,
		parentWorkflowDefinition,
		runSignal,
		runLimits,
		occurrences,
		getAgentCount,
		appendEvent,
		log,
		makeApi,
	} = host;
	throwIfAborted(runSignal.signal);
	const subWorkflow = await resolveWorkflow(ctx, name, "auto");
	if (path.resolve(subWorkflow.path) === path.resolve(parentWorkflowDefinition.path)) {
		throw new Error(
			`workflow() refused recursive call to ${subWorkflow.name}. Sub-workflows are depth-1 and may not call their parent.`,
		);
	}
	const subCode = await fs.readFile(subWorkflow.path, "utf8");
	const subCodeHash = computeCodeHash(subCode);
	const workflowCallKey = computeCallKey("workflow", [subWorkflow.name, workflowInput]);
	const workflowOcc = occurrences.next(workflowCallKey);
	const namespace = `workflow:${subWorkflow.name}:${subCodeHash.slice(0, 12)}:${workflowOcc}`;
	await appendEvent({
		type: "workflow",
		phase: "start",
		name: subWorkflow.name,
		file: subWorkflow.path,
		namespace,
		occ: workflowOcc,
	});
	await log(`sub-workflow start: ${subWorkflow.name}`, {
		file: subWorkflow.path,
		namespace,
		occ: workflowOcc,
		remainingAgents: Math.max(0, runLimits.maxAgents - getAgentCount()),
	});
	try {
		const result = await executeWorkflowCode(
			subWorkflow,
			subCode,
			makeApi(namespace, false, workflowInput),
			workflowInput,
			runLimits,
			runSignal.signal,
		);
		await appendEvent({
			type: "workflow",
			phase: "end",
			name: subWorkflow.name,
			namespace,
			occ: workflowOcc,
			ok: true,
		});
		await log(`sub-workflow end: ${subWorkflow.name}`, {
			namespace,
			occ: workflowOcc,
			remainingAgents: Math.max(0, runLimits.maxAgents - getAgentCount()),
		});
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.stack || err.message : String(err);
		await appendEvent({
			type: "workflow",
			phase: "error",
			name: subWorkflow.name,
			namespace,
			occ: workflowOcc,
			ok: false,
			error: message,
		});
		await log(`sub-workflow failed: ${subWorkflow.name}`, {
			namespace,
			occ: workflowOcc,
			error: message,
		});
		throw err;
	}
}
