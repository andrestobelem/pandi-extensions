/**
 * codex-ultracode — gateway read-only para una tarea libre invocada desde Codex.
 * El Contract Gate decide si alcanza una respuesta única; solo un routing dinámico abre fan-out.
 */
export const meta = {
	name: "codex-ultracode",
	description: "Router de Ultracode para Codex: contract-gate y ejecución read-only mínima.",
	phases: [{ title: "Contract" }, { title: "Plan" }, { title: "Work" }, { title: "Synthesize" }],
};

export default async function main() {
	const input = (() => {
		try {
			return typeof args === "string" ? JSON.parse(args) || {} : args || {};
		} catch {
			return {};
		}
	})();
	const request = input.request ?? input.task ?? input.text;
	if (!request) throw new Error('Pass { request: "the task to route" }.');

	phase("Contract");
	const gate = await workflow("contract-gate", {
		request,
		context: input.context ?? "",
		reviewers: input.reviewers ?? 3,
		planResources: false,
	});
	if (gate.verdict !== "PROCEED") {
		return {
			status: "blocked",
			contract: gate.contract,
			questions: gate.questions ?? [],
		};
	}

	const contract = gate.contract;
	const task = gate.rewrittenPrompt ?? request;
	if (contract.routingHint?.shape !== "dynamic-workflow") {
		phase("Work");
		const output = await agent(task, {
			label: "single-agent",
			model: input.model,
			effort: input.effort,
		});
		return { status: "completed", mode: "single-agent", contract, output };
	}

	phase("Plan");
	const plan = await agent(
		`Descomponé esta tarea en 2 a 6 unidades independientes de investigación read-only. ` +
			`No propongas ediciones, shell ni acceso fuera del workspace. Devolvé JSON estricto.\n\nTarea:\n${task}`,
		{
			label: "plan-work",
			model: input.model,
			effort: input.effort,
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["work"],
				properties: {
					work: {
						type: "array",
						minItems: 2,
						maxItems: 6,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["title", "focus"],
							properties: {
								title: { type: "string" },
								focus: { type: "string" },
							},
						},
					},
				},
			},
		},
	);
	const work = Array.isArray(plan.work) ? plan.work : [];
	if (work.length < 2) throw new Error("Codex planning returned fewer than two independent work units.");

	phase("Work");
	const branches = await agents(
		work.map((item) => ({
			label: item.title,
			prompt:
				`Investigá esta unidad de forma read-only y devolvé evidencia, incertidumbres y recomendaciones.\n\n` +
				`Tarea global:\n${task}\n\nUnidad:\n${item.focus}`,
			model: input.model,
			effort: input.effort,
		})),
		{ concurrency: Math.min(work.length, Number(input.concurrency ?? limits.concurrency)), settle: true },
	);
	const completed = branches.filter(Boolean);

	phase("Synthesize");
	const output = await agent(
		`Sintetizá una respuesta verificable para la tarea a partir de las ramas. ` +
			`Mencioná cobertura, ramas fallidas o vacías e incertidumbres; no inventes evidencia.\n\n` +
			`Tarea:\n${task}\n\nRamas:\n${JSON.stringify(completed)}`,
		{ label: "synthesis", model: input.model, effort: input.effort },
	);
	return {
		status: "completed",
		mode: "dynamic-workflow",
		contract,
		coverage: { completed: completed.length, total: branches.length },
		output,
	};
}
