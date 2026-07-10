import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildWorkflowGraphModel,
	buildWorkflowGraphModelWithSubworkflows,
	type ResolveWorkflowFn,
} from "../lib/graph/index.js";
import { transformWorkflowCode } from "../surface/index.js";
import type { WorkflowDefinition } from "../types.js";
import { writeJsonFile } from "./store.js";

// Escribe snapshots de source/transformed/graph para un directorio de run.

export interface WriteWorkflowRunSnapshotsOptions {
	resolveWorkflow?: ResolveWorkflowFn;
}

export async function writeWorkflowRunSnapshots(
	ctx: ExtensionContext,
	workflowDefinition: WorkflowDefinition,
	code: string,
	runDir: string,
	options?: WriteWorkflowRunSnapshotsOptions,
): Promise<void> {
	await fs.writeFile(path.join(runDir, "workflow-source.js"), code, "utf8");
	await fs.writeFile(path.join(runDir, "workflow-transformed.cjs"), transformWorkflowCode(code), "utf8");
	try {
		const graph = options?.resolveWorkflow
			? await buildWorkflowGraphModelWithSubworkflows(ctx, workflowDefinition, code, options.resolveWorkflow)
			: buildWorkflowGraphModel(workflowDefinition, code);
		await writeJsonFile(path.join(runDir, "workflow-graph.json"), graph);
	} catch (err) {
		await writeJsonFile(path.join(runDir, "workflow-graph.json"), {
			workflow: { name: workflowDefinition.name, scope: workflowDefinition.scope, path: workflowDefinition.path },
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
