// ---------------------------------------------------------------------------
// Recursion guard (PI_DYNAMIC_WORKFLOWS_DEPTH)
// ---------------------------------------------------------------------------
// ctx.workflow() composition is depth-1, and a single run is bounded by maxAgents, but a
// subagent spawned with includeExtensions:true + the dynamic_workflow tool could otherwise
// launch fresh top-level runs that are NOT counted against the parent's budget — unbounded
// nesting (a fork bomb). We propagate a per-session DEPTH env into every spawned subagent
// (depth+1) and refuse start/run/resume once a session is at the limit.
export const WORKFLOW_DEPTH_ENV = "PI_DYNAMIC_WORKFLOWS_DEPTH";
const DEFAULT_MAX_WORKFLOW_DEPTH = 2;

/** Workflow-nesting depth of THIS session (0 at the top-level Pi session). */
export function currentWorkflowDepth(): number {
	const raw = Number.parseInt(process.env[WORKFLOW_DEPTH_ENV] ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Max nesting before start/run/resume is refused (override via PI_DYNAMIC_WORKFLOWS_MAX_DEPTH). */
export function maxWorkflowDepth(): number {
	const raw = Number.parseInt(process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH ?? "", 10);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_WORKFLOW_DEPTH;
}
