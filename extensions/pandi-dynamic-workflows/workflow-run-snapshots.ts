import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeJsonFile } from "./run-store.js";
import { buildWorkflowGraphModelWithSubworkflows } from "./tui/graph/index.js";
import type { WorkflowDefinition } from "./types.js";
import { transformWorkflowCode } from "./workflow-transform.js";

// Escribe snapshots de source/transformed/graph para un directorio de run.

export async function writeWorkflowRunSnapshots(
	ctx: ExtensionContext,
	workflowDefinition: WorkflowDefinition,
	code: string,
	runDir: string,
): Promise<void> {
	await fs.writeFile(path.join(runDir, "workflow-source.js"), code, "utf8");
	await fs.writeFile(path.join(runDir, "workflow-transformed.cjs"), transformWorkflowCode(code), "utf8");
	try {
		const graph = await buildWorkflowGraphModelWithSubworkflows(ctx, workflowDefinition, code);
		await writeJsonFile(path.join(runDir, "workflow-graph.json"), graph);
	} catch (err) {
		await writeJsonFile(path.join(runDir, "workflow-graph.json"), {
			workflow: { name: workflowDefinition.name, scope: workflowDefinition.scope, path: workflowDefinition.path },
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
