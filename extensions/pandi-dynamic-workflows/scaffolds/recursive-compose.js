/**
 * recursive-compose — ejemplo de referencia: re-gateo Phase-0 + composición recursiva acotada.
 *
 * Runtime: anida llamadas a workflow(), así que necesita profundidad >= 2.
 *   • pi: funciona con PI_DYNAMIC_WORKFLOWS_MAX_DEPTH >= 2. Esta cadena llega a profundidad 3,
 *     así que 3 alcanza y es el cap esperado.
 *   • Claude Code Workflow: solo depth-1. El salto router → chosen-workflow cae en depth 2;
 *     este archivo captura ese guard y devuelve "DEPTH_BLOCKED" con guía, en vez de romper.
 *
 * Patrón: un nodo vuelve a gatear una subtarea con contract-gate y luego despacha el scaffold
 * recomendado vía router. También propaga el budget sugerido por el gate (resourcePlan).
 *
 * Depth ledger (cap = 3):
 *   depth 0: recursive-compose (este archivo)
 *     → workflow('contract-gate', { generate:false })      depth 1   (re-scope Phase-0)
 *     → workflow('router', { runSelected:true })            depth 1
 *          → router ejecuta el scaffold elegido            depth 2
 *               → si ese scaffold también compone          depth 3   (el cap)
 *
 * Es composición pura: no define nodos agent() propios. Los knobs de model/effort/tools fluyen a
 * los workflows compuestos, y resourcePlan.models/efforts se reenvía en args.
 *
 * A diferencia de `router` (despacha uno) y `contract-gate` (solo acota), este archivo encadena
 * gate → dispatch para que la decisión de Phase-0 dispare la ejecución.
 *
 * Input:  { task (required; aliases request/text), context?, args? (forwarded to the chosen workflow) }
 * Output: { status, gate?, dispatched? } — DONE | NEEDS_CLARIFICATION | NO_COMPOSE | DEPTH_BLOCKED
 */
export const meta = {
	name: "recursive-compose",
	basedOn: [
		{ name: "contract-gate", role: "composed-via (re-gate)" },
		{ name: "router", role: "composed-via (dispatch)" },
	],
	description:
		"REFERENCE (pi, depth<=3): un nodo vuelve a gatear una tarea vía Phase-0 contract-gate y luego despacha el scaffold recomendado vía router — composición recursiva acotada (recursive-compose)",
	phases: [{ title: "Gate" }, { title: "Dispatch" }],
};

export default async function main() {
	const input = (() => {
		try {
			return typeof args === "string" ? JSON.parse(args) || {} : args || {};
		} catch {
			return {};
		}
	})();

	const compact = (d, n = 60000) => {
		const s = typeof d === "string" ? d : JSON.stringify(d);
		return s.length > n ? `${s.slice(0, n)} …[truncated]` : s;
	};

	const task = input?.task ?? input?.request ?? input?.text;
	if (!task) throw new Error('Pass { task: "..." } (aliases: request, text).');
	const passArgs = input?.args && typeof input.args === "object" ? input.args : {};

	// depth 1 — re-scope con Phase-0. generate:false evita un nivel extra y reserva budget para
	// el dispatch de abajo.
	phase("Gate");
	let gate;
	try {
		gate = await workflow("contract-gate", { request: task, context: input?.context, generate: false });
	} catch (err) {
		return {
			status: "DEPTH_BLOCKED",
			stage: "gate",
			error: String(err?.message ?? err),
			note: "The Phase-0 nested call was refused by the runtime recursion guard. Run at the top level, or on pi with PI_DYNAMIC_WORKFLOWS_MAX_DEPTH>=2.",
		};
	}
	if (gate?.status !== "PROCEED") {
		log(`gate did not PROCEED ${JSON.stringify({ status: gate?.status })}`);
		return { status: "NEEDS_CLARIFICATION", questions: gate?.questions ?? [], gate };
	}
	const routing = gate?.routing ?? null;
	log(
		"gate PROCEED " +
			JSON.stringify({ shape: routing?.shape, pattern: routing?.pattern, tier: gate?.resourcePlan?.tier }),
	);
	if (routing?.shape !== "dynamic-workflow") {
		// Trivial / single-agent: there is nothing to compose deeper — return the scoped prompt.
		return {
			status: "NO_COMPOSE",
			reason: `routing is ${routing?.shape ?? "unknown"} — no dynamic workflow to dispatch`,
			rewrittenPrompt: gate.rewrittenPrompt,
			gate,
		};
	}

	// depth 1 → 2 (→ 3) — despacha el scaffold recomendado vía router. Si el elegido también
	// compone, su sub-llamada cae en depth 3. Reenvía el budget sugerido por el gate en args.
	phase("Dispatch");
	const dispatchArgs = {
		...passArgs,
		...(gate?.resourcePlan?.models ? { models: gate.resourcePlan.models } : {}),
		...(gate?.resourcePlan?.efforts ? { efforts: gate.resourcePlan.efforts } : {}),
	};
	let dispatched;
	try {
		dispatched = await workflow("router", {
			request: compact(gate.rewrittenPrompt),
			runSelected: true,
			args: dispatchArgs,
		});
	} catch (err) {
		return {
			status: "DEPTH_BLOCKED",
			stage: "dispatch",
			error: String(err?.message ?? err),
			note: "router → chosen workflow exceeded the runtime nesting depth. Claude Code is depth-1; run on pi with PI_DYNAMIC_WORKFLOWS_MAX_DEPTH>=2 (<=3 covers this chain).",
			gate: { improvedTask: gate?.contract?.improvedTask, routing },
		};
	}
	log(`dispatched ${JSON.stringify({ selected: dispatched?.selected, dispatched: dispatched?.dispatched })}`);

	return {
		status: "DONE",
		gate: { improvedTask: gate?.contract?.improvedTask, routing, resourcePlan: gate?.resourcePlan ?? null },
		dispatched,
	};
}
