#!/usr/bin/env node
/**
 * Contract test for the pure DynamicWorkflowToolParams -> DynamicWorkflowRequest classifier.
 *
 * The public tool keeps the legacy `name` field for compatibility, but inside the
 * extension it should be interpreted as exactly one domain target: workflow definition,
 * run, pattern scaffold, or collection action.
 */
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function loadModule() {
	const { url } = await buildExtension({
		name: "pandi-dwf-workflow-tool-request",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "workflow-tool-request.ts"),
		outName: "workflow-tool-request.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	return await import(url);
}

async function main() {
	const { classifyDynamicWorkflowRequest } = await loadModule();
	check(
		"exports classifier",
		typeof classifyDynamicWorkflowRequest === "function",
		typeof classifyDynamicWorkflowRequest,
	);

	{
		const request = classifyDynamicWorkflowRequest({ action: "read", name: "audit", scope: "project" });
		check("read targets a workflow definition", request.kind === "workflow-definition", JSON.stringify(request));
		check("workflow definition keeps the workflow name", request.workflowName === "audit", JSON.stringify(request));
		check("workflow definition keeps explicit scope", request.scope === "project", JSON.stringify(request));
	}

	{
		const request = classifyDynamicWorkflowRequest({
			action: "run",
			name: "drafts/a",
			input: { x: 1 },
			concurrency: 2,
		});
		check("run targets a workflow definition", request.kind === "workflow-definition", JSON.stringify(request));
		check("run defaults scope to auto", request.scope === "auto", JSON.stringify(request));
		check(
			"run preserves original params for limits/input",
			request.params.concurrency === 2,
			JSON.stringify(request),
		);
	}

	{
		const request = classifyDynamicWorkflowRequest({ action: "view" });
		check("view targets a run", request.kind === "run", JSON.stringify(request));
		check("missing run id is allowed for latest/default", request.runId === undefined, JSON.stringify(request));
	}

	{
		const request = classifyDynamicWorkflowRequest({ action: "resume", name: "run-123", force: true });
		check("resume targets a run", request.kind === "run", JSON.stringify(request));
		check("resume maps name to runId", request.runId === "run-123", JSON.stringify(request));
		check("resume preserves force flag", request.params.force === true, JSON.stringify(request));
	}

	{
		const request = classifyDynamicWorkflowRequest({ action: "scaffold", name: "fan-out-and-synthesize" });
		check("scaffold targets a pattern scaffold", request.kind === "pattern-scaffold", JSON.stringify(request));
		check(
			"scaffold maps name to patternKey",
			request.patternKey === "fan-out-and-synthesize",
			JSON.stringify(request),
		);
	}

	{
		const request = classifyDynamicWorkflowRequest({ action: "scaffold" });
		check(
			"scaffold without name is still a pattern-scaffold request",
			request.kind === "pattern-scaffold",
			JSON.stringify(request),
		);
		check(
			"missing pattern key is allowed for catalog/default scaffold",
			request.patternKey === undefined,
			JSON.stringify(request),
		);
	}

	{
		const request = classifyDynamicWorkflowRequest({ action: "runs" });
		check("runs is a collection request", request.kind === "collection", JSON.stringify(request));
	}

	{
		let message = "";
		try {
			classifyDynamicWorkflowRequest({ action: "check" });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		check(
			"workflow-definition actions still require name",
			message === "dynamic_workflow action=check requires name.",
			message,
		);
	}

	if (counts.failed > 0) {
		console.error(`\n${counts.failed} failed, ${counts.passed} passed`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} passed, 0 failed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
