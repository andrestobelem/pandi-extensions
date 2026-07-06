import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PreparedWorkflowRun } from "./types.js";
import { createRunDirectory, ensureDir } from "./workflow-resolve.js";

export async function prepareWorkflowRun(
	ctx: ExtensionContext,
	workflowName: string,
	background = false,
): Promise<PreparedWorkflowRun> {
	const started = Date.now();
	const { runId, runDir } = await createRunDirectory(ctx, workflowName, started);
	await ensureDir(path.join(runDir, "agents"));
	return { started, runId, runDir, background };
}
