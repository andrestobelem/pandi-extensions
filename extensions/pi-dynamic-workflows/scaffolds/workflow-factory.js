/**
 * Workflow factory / meta-workflow.
 *
 * Given a task, spend one workflow run designing the RIGHT task-specific
 * workflow: improve prompts, choose primitives/patterns, generate code, review
 * it, then write the gitignored `.pi/workflows/drafts/<slug>.js` draft by default.
 *
 * Input: { task: "...", name?: "<slug>", write?: boolean }
 * - write=false keeps the generated JS as artifacts only.
 * - The generated workflow is a draft: inspect/edit before trusting it for high
 *   cost or mutating work.
 */
module.exports = async function workflow(ctx, input) {
	const task = input?.task ?? input?.request ?? input?.text;
	if (!task) throw new Error('Pass { task: "what the workflow should accomplish" }.');

	const slug = (value) =>
		String(value)
			.toLowerCase()
			.replace(/[^a-z0-9._/-]+/g, "-")
			.replace(/(^|\/)\.\.(?=\/|$)/g, "")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "workflow-draft";
	const safeName = slug(input?.name ?? slug(task));
	const workflowName = safeName.endsWith(".js") ? safeName.slice(0, -3) : safeName;
	const workflowPath = `.pi/workflows/drafts/${workflowName}.js`;
	const extractJs = (text) => {
		const match = /```(?:js|javascript)?\s*\n([\s\S]*?)```/i.exec(String(text ?? ""));
		return (match ? match[1] : String(text ?? "")).trim();
	};

	const PLAN = {
		type: "object",
		additionalProperties: false,
		required: ["name", "pattern", "why", "inputs", "scout", "primitives", "promptContracts", "verification", "risks"],
		properties: {
			name: { type: "string" },
			pattern: { type: "string" },
			why: { type: "string" },
			inputs: { type: "array", items: { type: "string" } },
			scout: { type: "string" },
			primitives: { type: "array", items: { type: "string" } },
			promptContracts: { type: "array", items: { type: "string" } },
			verification: { type: "array", items: { type: "string" } },
			risks: { type: "array", items: { type: "string" } },
		},
	};

	await ctx.log("workflow-factory planning", { task, workflowName });
	const planResult = await ctx.agent(
		`Design a Pi dynamic workflow for this task. Choose the minimal sufficient orchestration pattern.\n\n` +
			`Task:\n${task}\n\n` +
			`Available primitives: ctx.agent, ctx.agents({settle}), ctx.pipeline, ctx.parallel, ctx.workflow for reusable sub-steps, ctx.bash, ctx.writeArtifact.\n` +
			`Default subagent access: web_search is added when pi-codex-web-search is installed, and context7-cli is available when installed; do not opt out unless isolation is required.\n` +
			`Return JSON matching the schema. Include prompt contracts with evidence rules, partial-failure handling, caps, and verification strategy.`,
		{ name: "workflow-plan", agentType: "planner", tools: ["read", "grep", "find", "ls"], schema: PLAN },
	);
	const plan = planResult.data ?? {
		name: workflowName,
		pattern: "custom",
		why: "planner returned unstructured output",
	};
	await ctx.writeArtifact("workflow-plan.json", plan);

	const implement = await ctx.agent(
		`Generate a COMPLETE JavaScript Pi dynamic workflow for this task. Return ONLY JavaScript, no Markdown fences.\n\n` +
			`Task:\n${task}\n\n` +
			`Design plan:\n${ctx.compact(plan, 12000)}\n\n` +
			`Hard requirements:\n` +
			`- module.exports = async function workflow(ctx, input) { ... }\n` +
			`- No import/require. Use only ctx helpers and plain JS.\n` +
			`- Choose concurrency from input/ctx.limits; never silently cap coverage.\n` +
			`- Use read-only subagent tools unless the task explicitly requires mutation; include web_search when web/docs/current evidence may help.\n` +
			`- Dynamic Workflows auto-loads web_search and context7-cli when installed; do not set includeExtensions:false/includeSkills:false unless explicitly opting out.\n` +
			`- Persist artifacts for work-list, raw branch outputs, review notes, and final summary.\n` +
			`- Use evidence contracts: cite files/lines/URLs/commands or say NO_FINDINGS/INSUFFICIENT_EVIDENCE.\n` +
			`- If a reusable sub-step is needed with no human decision in between, call ctx.workflow(name, args); otherwise keep phases in this workflow.`,
		{ name: "workflow-codegen", agentType: "implementer", tools: ["read", "grep", "find", "ls"] },
	);
	let code = extractJs(implement.output);
	await ctx.writeArtifact("generated-workflow.initial.js", code);

	const review = await ctx.agent(
		`Review this generated Pi workflow for correctness, cost, safety, prompt quality, and composability.\n` +
			`Find concrete issues only; cite the problematic snippet. If it is acceptable, say APPROVED.\n\n` +
			`Task:\n${task}\n\nWorkflow code:\n\n${code}`,
		{ name: "workflow-review", agentType: "reviewer", tools: ["read", "grep", "find", "ls"] },
	);
	await ctx.writeArtifact("workflow-review.md", review.output);

	const refine = await ctx.agent(
		`Revise the workflow code to address this review. Return ONLY final JavaScript.\n\n` +
			`Task:\n${task}\n\nReview:\n${review.output}\n\nCurrent code:\n\n${code}`,
		{ name: "workflow-refine", agentType: "implementer", tools: ["read", "grep", "find", "ls"] },
	);
	code = extractJs(refine.output);
	await ctx.writeArtifact("generated-workflow.js", code);

	let written;
	if (input?.write !== false) {
		written = await ctx.writeFile(workflowPath, `${code}\n`);
		await ctx.log("generated workflow written", { path: written.path, workflowName });
	} else {
		await ctx.log("write=false: generated workflow kept as artifacts only", { workflowName });
	}

	return [
		`Generated workflow draft: ${workflowName}`,
		written ? `Wrote: ${written.path}` : "Not written (write=false); see artifact generated-workflow.js.",
		`Pattern: ${plan.pattern ?? "custom"}`,
		`Why: ${plan.why ?? "n/a"}`,
		"Next: inspect/edit the generated workflow, then run it with explicit concurrency/maxAgents.",
	].join("\n");
};
