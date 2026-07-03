/**
 * recursive-compose — REFERENCE example: Phase-0-from-inside + bounded recursive composition.
 *
 * RUNTIME: this nests workflow() calls, so it needs a runtime that allows nesting depth >= 2.
 *   • pi: works with PI_DYNAMIC_WORKFLOWS_MAX_DEPTH >= 2. This chain tops out at depth 3, so
 *     PI_DYNAMIC_WORKFLOWS_MAX_DEPTH <= 3 is enough (and 3 is the intended cap).
 *   • Claude Code Workflow tool: depth-1 only — the router→chosen-workflow hop is depth 2 and the
 *     runtime throws a recursion guard. This file CATCHES that and returns status "DEPTH_BLOCKED"
 *     with guidance, so it degrades cleanly instead of crashing. (Run it under pi to see the full chain.)
 *
 * WHAT IT SHOWS (the composition pattern you asked for): a node RE-GATES a (sub)task with the
 * Phase-0 contract-gate, then DISPATCHES the recommended scaffold via the router — composing the
 * catalog recursively, within the depth budget, and carrying the gate's suggested per-node budget
 * (resourcePlan) down to the dispatched run.
 *
 * DEPTH LEDGER (cap = 3):
 *   depth 0: recursive-compose (this file, run at the top)
 *     → workflow('contract-gate', { generate:false })      depth 1   (Phase-0 re-scope; no deeper nesting)
 *     → workflow('router', { runSelected:true })            depth 1
 *          → router runs the chosen scaffold                depth 2
 *               → if that scaffold is itself a composer     depth 3   (e.g. composition-driver
 *                 (calls workflow(...))                                 → verify-claims-lib) — the cap
 *
 * This file is PURE COMPOSITION (no agent() nodes of its own): all model/effort/tools knobs flow
 * THROUGH to the composed workflows. The gate's resourcePlan.models/efforts are forwarded into the
 * dispatched run's args so the deep work runs on the gate-suggested budget.
 *
 * Differs from `router` (which dispatches ONE workflow) and `contract-gate` (which only scopes):
 * this chains gate → dispatch so the Phase-0 decision actually drives a (possibly deeper) run.
 *
 * Input:  { task (REQUIRED; aliases request/text), context?, args? (forwarded to the chosen workflow) }
 * Output: { status, gate?, dispatched? } — DONE | NEEDS_CLARIFICATION | NO_COMPOSE | DEPTH_BLOCKED
 *
 * Uses: workflow('contract-gate', …) for Phase-0 re-scope, workflow('router', …) for dispatch,
 * try/catch around each nested call so a recursion-guard (depth) error is surfaced, not thrown.
 */
export const meta = {
  name: 'recursive-compose',
  basedOn: [{ name: 'contract-gate', role: 'composed-via (re-gate)' }, { name: 'router', role: 'composed-via (dispatch)' }],
  description: 'REFERENCE (pi, depth<=3): a node re-gates a task via Phase-0 contract-gate then dispatches the recommended scaffold via router — bounded recursive composition (recursive-compose)',
  phases: [
    { title: 'Gate' },
    { title: 'Dispatch' },
  ],
};

const input = (() => { try { return typeof args === 'string' ? (JSON.parse(args) || {}) : (args || {}); } catch { return {}; } })();

const compact = (d, n = 60000) => {
  const s = typeof d === 'string' ? d : JSON.stringify(d);
  return s.length > n ? s.slice(0, n) + ' …[truncated]' : s;
};

const task = input?.task ?? input?.request ?? input?.text;
if (!task) throw new Error('Pass { task: "..." } (aliases: request, text).');
const passArgs = (input?.args && typeof input.args === 'object') ? input.args : {};

// depth 1 — Phase-0 RE-SCOPE the task. generate:false so contract-gate itself does NOT nest further
// (calling the factory would add a level); we want the depth budget for the dispatch below.
phase('Gate');
let gate;
try {
  gate = await workflow('contract-gate', { request: task, context: input?.context, generate: false });
} catch (err) {
  return { status: 'DEPTH_BLOCKED', stage: 'gate', error: String(err?.message ?? err),
    note: 'The Phase-0 nested call was refused by the runtime recursion guard. Run at the top level, or on pi with PI_DYNAMIC_WORKFLOWS_MAX_DEPTH>=2.' };
}
if (gate?.status !== 'PROCEED') {
  log('gate did not PROCEED ' + JSON.stringify({ status: gate?.status }));
  return { status: 'NEEDS_CLARIFICATION', questions: gate?.questions ?? [], gate };
}
const routing = gate?.routing ?? null;
log('gate PROCEED ' + JSON.stringify({ shape: routing?.shape, pattern: routing?.pattern, tier: gate?.resourcePlan?.tier }));
if (!routing || routing.shape !== 'dynamic-workflow') {
  // Trivial / single-agent: there is nothing to compose deeper — return the scoped prompt.
  return { status: 'NO_COMPOSE', reason: `routing is ${routing?.shape ?? 'unknown'} — no dynamic workflow to dispatch`, rewrittenPrompt: gate.rewrittenPrompt, gate };
}

// depth 1 → 2 (→ 3) — DISPATCH the recommended scaffold via router (router runs the choice at
// depth 2; if that choice is itself a composer, its sub-call is depth 3 — the cap). Forward the
// gate's suggested per-node budget into the dispatched run's args.
phase('Dispatch');
const dispatchArgs = {
  ...passArgs,
  ...(gate?.resourcePlan?.models ? { models: gate.resourcePlan.models } : {}),
  ...(gate?.resourcePlan?.efforts ? { efforts: gate.resourcePlan.efforts } : {}),
};
let dispatched;
try {
  dispatched = await workflow('router', { request: compact(gate.rewrittenPrompt), runSelected: true, args: dispatchArgs });
} catch (err) {
  return { status: 'DEPTH_BLOCKED', stage: 'dispatch', error: String(err?.message ?? err),
    note: 'router → chosen workflow exceeded the runtime nesting depth. Claude Code is depth-1; run on pi with PI_DYNAMIC_WORKFLOWS_MAX_DEPTH>=2 (<=3 covers this chain).',
    gate: { improvedTask: gate?.contract?.improvedTask, routing } };
}
log('dispatched ' + JSON.stringify({ selected: dispatched?.selected, dispatched: dispatched?.dispatched }));

return {
  status: 'DONE',
  gate: { improvedTask: gate?.contract?.improvedTask, routing, resourcePlan: gate?.resourcePlan ?? null },
  dispatched,
};
