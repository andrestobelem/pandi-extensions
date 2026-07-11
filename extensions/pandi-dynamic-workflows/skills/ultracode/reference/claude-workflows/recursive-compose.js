/**
 * recursive-compose — referencia de frontera para el límite de composición depth-1.
 *
 * Tanto pi como la Workflow tool de Claude permiten que el workflow top-level componga hijos,
 * pero un hijo no puede volver a llamar workflow(). PI_DYNAMIC_WORKFLOWS_MAX_DEPTH protege runs
 * top-level iniciados por subagentes y NO amplía este límite de composición.
 *
 * Esta referencia vuelve a acotar la tarea con contract-gate y consulta router como dos hijos
 * hermanos de depth 1. Router corre con runSelected:false: devuelve una recomendación, pero no
 * intenta el salto router → workflow elegido que requeriría depth 2. El resultado DEPTH_BLOCKED
 * indica que el orquestador debe lanzar esa recomendación como una corrida top-level separada.
 * dispatchArgs combina suggestedArgs de router con overrides explícitos y el resourcePlan del gate.
 *
 * Depth ledger:
 *   depth 0: recursive-compose (este archivo)
 *     → workflow('contract-gate', { generate:false })      depth 1
 *     → workflow('router', { runSelected:false })           depth 1
 *     ✕ router → workflow elegido                           depth 2 (no permitido)
 *
 * Input:  { task (required; aliases request/text), context?, args? }
 * Output: { status, gate?, recommendation?, dispatchArgs? }
 *         NEEDS_CLARIFICATION | NO_COMPOSE | DEPTH_BLOCKED
 */
export const meta = {
	name: "recursive-compose",
	basedOn: [
		{ name: "contract-gate", role: "composed-via (re-gate)" },
		{ name: "router", role: "composed-via (recommendation-only)" },
	],
	description:
		"BOUNDARY REFERENCE (depth-1): vuelve a gatear una tarea, obtiene una recomendación de router sin despacharla y muestra cuándo continuar con otra corrida top-level",
	phases: [{ title: "Gate" }, { title: "Route" }],
};

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

// depth 1 — re-scope con Phase-0. generate:false impide que contract-gate intente otro salto.
phase("Gate");
let gate;
try {
	gate = await workflow("contract-gate", { request: task, context: input?.context, generate: false });
} catch (err) {
	return {
		status: "DEPTH_BLOCKED",
		stage: "gate",
		error: String(err?.message ?? err),
		note: "El runtime rechazó la composición: ejecutá recursive-compose como workflow top-level.",
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

// Router es otro hijo depth-1. Recommendation-only evita que intente un workflow() depth-2.
phase("Route");
const dispatchOverrides = {
	...passArgs,
	...(gate?.resourcePlan?.models ? { models: gate.resourcePlan.models } : {}),
	...(gate?.resourcePlan?.efforts ? { efforts: gate.resourcePlan.efforts } : {}),
};
let recommendation;
try {
	recommendation = await workflow("router", {
		request: compact(gate.rewrittenPrompt),
		runSelected: false,
		args: dispatchOverrides,
	});
} catch (err) {
	return {
		status: "NO_COMPOSE",
		stage: "dispatch",
		error: String(err?.message ?? err),
		note: "Router no pudo producir una recomendación. No se intentó ningún dispatch anidado.",
		gate: { improvedTask: gate?.contract?.improvedTask, routing },
	};
}
log(`recommendation ${JSON.stringify({ selected: recommendation?.selected, dispatched: false })}`);
if (!recommendation || recommendation.selected === "none") {
	return {
		status: "NO_COMPOSE",
		reason: "router did not find a workflow to run",
		gate: { improvedTask: gate?.contract?.improvedTask, routing, resourcePlan: gate?.resourcePlan ?? null },
		recommendation: recommendation ?? null,
	};
}
const suggestedArgs =
	recommendation.suggestedArgs &&
	typeof recommendation.suggestedArgs === "object" &&
	!Array.isArray(recommendation.suggestedArgs)
		? recommendation.suggestedArgs
		: {};
// La recomendación aporta el input primario; args explícitos ganan, y el resourcePlan del gate
// ya quedó aplicado al final de dispatchOverrides.
const dispatchArgs = { ...suggestedArgs, ...dispatchOverrides };

return {
	status: "DEPTH_BLOCKED",
	stage: "dispatch",
	note: "La composición workflow() tiene depth 1. Ejecutá el workflow elegido como otra corrida top-level; PI_DYNAMIC_WORKFLOWS_MAX_DEPTH no cambia este límite.",
	gate: { improvedTask: gate?.contract?.improvedTask, routing, resourcePlan: gate?.resourcePlan ?? null },
	recommendation,
	dispatchArgs,
};
