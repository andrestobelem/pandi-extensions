/**
 * Test de integración conductual durable para la expansión ESTÁTICA de sub-workflows en el GRAPH
 * de workflow (`dynamic_workflow action="graph"`) de extensions/pandi-dynamic-workflows/index.ts.
 *
 * Este es el análogo ESTÁTICO de dynamic-workflow-composition.test.mjs. Esa suite (y
 * los pases 5/6) solo ejercita composición en RUNTIME (action="run"/"resume" → runSubworkflow).
 * NADIE ejercitaba el graph ESTÁTICO que expande ctx.workflow("name") un nivel leyendo
 * el archivo child en preview time. Esa superficie fue introducida por los commits:
 *   - ccc51ca "feat(dynamic-workflows): expand subworkflows in workflow graphs"
 *   - 907f0c2 "fix(dynamic-workflows): ignore comments when graphing workflow calls"
 * vía buildWorkflowGraphModelWithSubworkflows (dynamic-workflows.ts ~:2527) → makeWorkflowGraphForContext.
 * Una regresión silenciosa acá es invisible para tsc (parseo de strings + resolución de archivos + render).
 *
 * Seis contratos OBSERVABLES pineados (todos salen en `details.graph` / texto de content de action=graph):
 *   1. Happy path literal: ctx.workflow("lib/rank-candidates") con nombre LITERAL resuelve el
 *      archivo child, lo parsea, y el graph contiene `expands: <name> (<n> steps)` más las
 *      líneas del sub-graph del child (renderWorkflowGraphSubworkflowSummaryLines).
 *   2. Nombre dinámico: ctx.workflow(someVar) NO se resuelve →
 *      "dynamic sub-workflow name; cannot resolve statically".
 *   3. Límite de profundidad: un child que a su vez llama ctx.workflow(...) (grandchild) no se expande →
 *      "nested sub-workflows are not expanded; runtime composition depth limit is 1".
 *   4. Guard de recursión: un workflow que se llama A SÍ MISMO (ctx.workflow("<own name>")) → en depth 0 el
 *      path resuelto ya está en `seen` → "recursive sub-workflow skipped: <name>". (Un ciclo más profundo
 *      pega primero con el mensaje de depth-limit, así que el guard se ejercita en la self-call depth-0.)
 *   5. Literal irresoluble: ctx.workflow("does-not-exist") → resolve hace throw, capturado en
 *      subworkflowError "Workflow not found: does-not-exist".
 *   6. Ignorar comentarios (907f0c2): un ctx.workflow(...) dentro de una línea // o block comment NO
 *      se detecta como step de sub-workflow.
 *
 * El graph solo PARSEA la fuente del child; nunca la ejecuta, así que los workflows child pueden ser
 * archivos fuente mínimos. Se instalan en .pi/workflows/{,lib/} de un proyecto temp exactamente como
 * el runtime los resuelve, y manejamos la tool REAL dynamic_workflow con action="graph".
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/composition-graph-expansion.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { check, counts } = createChecker();

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dwf-graph-integration" });
}

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	const activeTools = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: (key, opts) => shortcuts.push({ key, opts }),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, handlers, shortcuts };
}

function makeCtx(cwd) {
	const theme = { fg: (_color, value) => value };
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme,
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-graph-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function writeWorkflow(project, relativeName, code) {
	const file = path.join(
		project,
		".pi",
		"workflows",
		relativeName.endsWith(".js") ? relativeName : `${relativeName}.js`,
	);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, code, "utf8");
	return file;
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-integration", params, new AbortController().signal, undefined, ctx);
}

// Corré action=graph para `name` y devolvé el texto de graph renderizado (mismo string que ve el agente/usuario).
async function graphOf(url, project, name) {
	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	const response = await runTool(tools.get("dynamic_workflow"), ctx, { action: "graph", name });
	const fromDetails = response?.details?.graph;
	const fromContent = response?.content?.[0]?.text;
	// Ambas superficies deben llevar el mismo string de graph (guard de regresión sobre la forma de respuesta).
	if (typeof fromDetails === "string" && typeof fromContent === "string") {
		check(`graph[${name}]: details.graph === content text`, fromDetails === fromContent);
	}
	return fromDetails ?? fromContent ?? "";
}

// Workflow child library mínimo: dos steps ctx.*, sin ctx.workflow anidado.
const RANK_CHILD = `
module.exports = async function workflow(ctx, input) {
  const scored = await ctx.agents(input.candidates.map((c) => ({ prompt: "score " + c })), { name: "juror" });
  await ctx.writeArtifact("ranked.json", { scored });
  return { ranked: scored };
};
`;

// 1. Happy path literal: el parent llama un child lib/ literal; el child debe expandirse inline.
async function scenarioLiteralExpansion(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"graph-parent",
		`
module.exports = async function workflow(ctx, input) {
  const candidates = await ctx.agent("brainstorm options");
  const ranked = await ctx.workflow("lib/rank-candidates", { candidates: candidates.output });
  return { best: ranked.ranked[0] };
};
`,
	);
	await writeWorkflow(project, "lib/rank-candidates", RANK_CHILD);

	const graph = await graphOf(url, project, "graph-parent");
	check("literal: graph mentions the sub-workflow step", /sub-workflow/i.test(graph), graph.slice(0, 400));
	check(
		"literal: expands the child with step count",
		/expands:\s*lib\/rank-candidates\s*\(\d+ steps\)/.test(graph),
		graph,
	);
	check(
		"literal: renders the child sub-graph header",
		/↳ sub-workflow graph: lib\/rank-candidates \(\d+ steps\)/.test(graph),
		graph,
	);
	// Los steps propios del child (agents/writeArtifact) deben aparecer dentro del subgraph expandido.
	check(
		"literal: child fan-out step surfaced in subgraph",
		/ctx\.agents/.test(graph) && /ctx\.workflow/.test(graph),
		graph,
	);
	check("literal: child artifact step surfaced in subgraph", /ctx\.writeArtifact/.test(graph), graph);
	check("literal: emits the expansion note", /literal names are expanded one level/i.test(graph), graph);
	check("literal: no 'subgraph unavailable' for the resolvable child", !/subgraph unavailable/.test(graph), graph);
}

// 2. Nombre dinámico: ctx.workflow(variable) no se puede resolver estáticamente.
async function scenarioDynamicName(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"graph-dynamic",
		`
module.exports = async function workflow(ctx, input) {
  const which = input.pick;
  const out = await ctx.workflow(which, { x: 1 });
  return out;
};
`,
	);
	const graph = await graphOf(url, project, "graph-dynamic");
	check("dynamic: still detected as a sub-workflow step", /sub-workflow/i.test(graph), graph.slice(0, 400));
	check(
		"dynamic: reports cannot-resolve-statically",
		/dynamic sub-workflow name; cannot resolve statically/.test(graph),
		graph,
	);
	check("dynamic: does NOT claim to expand a child", !/expands:/.test(graph), graph);
}

// 3. Límite de profundidad: el child resuelve, pero su propio grandchild ctx.workflow no se expande (depth >= 1).
async function scenarioDepthLimit(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"graph-depth-parent",
		`
module.exports = async function workflow(ctx) {
  return await ctx.workflow("lib/depth-child", {});
};
`,
	);
	await writeWorkflow(
		project,
		"lib/depth-child",
		`
module.exports = async function workflow(ctx) {
  const g = await ctx.workflow("lib/depth-grandchild", {});
  return g;
};
`,
	);
	await writeWorkflow(project, "lib/depth-grandchild", "module.exports = async () => ({ ok: true });\n");

	const graph = await graphOf(url, project, "graph-depth-parent");
	check("depth: parent expands its direct child", /expands:\s*lib\/depth-child/.test(graph), graph);
	check(
		"depth: grandchild is not expanded (depth limit message)",
		/nested sub-workflows are not expanded; runtime composition depth limit is 1/.test(graph),
		graph,
	);
	check("depth: grandchild's own body is NOT inlined", !/depth-grandchild \(\d+ steps\)/.test(graph), graph);
}

// 4. Guard de recursión: un workflow que se llama A SÍ MISMO. En depth 0, el self-path resuelto ya está
//    en `seen`, así que dispara el guard basado en seen (NO la rama de depth-limit, que solo dispara en
//    depth >= 1, es decir, un nivel más profundo). Esto pinea el mensaje recursive-skip distinto.
async function scenarioRecursionGuard(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"graph-recur",
		`
module.exports = async function workflow(ctx) {
  // self-call: resolves back to graph-recur, which is the current path (depth 0 → seen guard)
  return await ctx.workflow("graph-recur", {});
};
`,
	);
	const graph = await graphOf(url, project, "graph-recur");
	check("recursion: self-call detected as a sub-workflow step", /sub-workflow/i.test(graph), graph.slice(0, 400));
	check(
		"recursion: self-call is skipped via seen-guard",
		/recursive sub-workflow skipped: graph-recur/.test(graph),
		graph,
	);
	// Críticamente NO es el mensaje de depth-limit: el seen-guard debe ganar para una self-call depth-0.
	check("recursion: not mislabeled as depth-limit", !/depth limit is 1/.test(graph), graph);
	check("recursion: does not infinitely inline itself", !/expands:\s*graph-recur/.test(graph), graph);
}

// 5. Literal irresoluble: ctx.workflow("does-not-exist") → resolve hace throw, capturado en subworkflowError.
async function scenarioUnresolvable(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"graph-missing",
		`
module.exports = async function workflow(ctx) {
  return await ctx.workflow("lib/no-such-workflow", {});
};
`,
	);
	const graph = await graphOf(url, project, "graph-missing");
	check("unresolvable: detected as a sub-workflow step", /sub-workflow/i.test(graph), graph.slice(0, 400));
	check("unresolvable: surfaces Workflow not found", /Workflow not found: lib\/no-such-workflow/.test(graph), graph);
	check("unresolvable: does NOT claim to expand", !/expands:\s*lib\/no-such-workflow/.test(graph), graph);
}

// 6. Ignorar comentarios (907f0c2): ctx.workflow(...) dentro de comentarios NO debe graficarse.
async function scenarioCommentIgnored(url) {
	const project = await makeProject();
	// Solo llamadas ctx.workflow comentadas; el cuerpo vivo tiene un único ctx.agent real.
	await writeWorkflow(
		project,
		"graph-commented",
		`
module.exports = async function workflow(ctx) {
  // const dead = await ctx.workflow("lib/rank-candidates", {});
  /* await ctx.workflow("lib/rank-candidates", { also: "dead" }); */
  const real = await ctx.agent("only real step");
  return real.output;
};
`,
	);
	// El target resolvible existe, así que si una llamada comentada SE graficara incluso expandiría,
	// haciendo ruidoso el bug. El contrato: no debe detectarse en absoluto.
	await writeWorkflow(project, "lib/rank-candidates", RANK_CHILD);

	const graph = await graphOf(url, project, "graph-commented");
	check("comments: commented ctx.workflow is NOT detected as a sub-workflow", !/sub-workflow/i.test(graph), graph);
	check("comments: does not expand the commented child", !/expands:\s*lib\/rank-candidates/.test(graph), graph);
	check("comments: the real ctx.agent step IS present", /ctx\.agent\b/.test(graph), graph);

	// Control positivo: un workflow IDÉNTICO con la llamada DEScomentada SÍ expande → prueba que
	// el negativo anterior lo causa el comentario, no algún fallo de parseo no relacionado.
	await writeWorkflow(
		project,
		"graph-uncommented",
		`
module.exports = async function workflow(ctx) {
  const live = await ctx.workflow("lib/rank-candidates", {});
  const real = await ctx.agent("only real step");
  return { live, real: real.output };
};
`,
	);
	const liveGraph = await graphOf(url, project, "graph-uncommented");
	check(
		"comments(control): uncommented ctx.workflow DOES expand",
		/expands:\s*lib\/rank-candidates/.test(liveGraph),
		liveGraph,
	);
}

// Workflow child library estilo globals (export default main() + globals inyectados, sin ctx.*).
const RANK_CHILD_GLOBALS = `
export default async function main() {
  const scored = await agents(args.candidates.map((c) => ({ prompt: "score " + c })), { name: "juror" });
  await writeArtifact("ranked.json", { scored });
  return { ranked: scored };
};
`;

// Parent estilo globals: llamadas desnudas agent()/agents()/workflow()/writeArtifact() (sin ctx.*). El
// parser de graph debe detectarlas exactamente como llamadas ctx.*; antes solo matcheaba `ctx.<m>(`,
// así que un workflow estilo globals renderizaba un graph VACÍO ("No ... workflow API calls detected").
async function scenarioGlobalsStyleDetected(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"graph-globals",
		`
export default async function main() {
  const candidates = await agent("brainstorm options");
  const ranked = await workflow("lib/rank-globals", { candidates });
  const scored = await agents(["a", "b"].map((c) => ({ prompt: "score " + c })), { concurrency: 4 });
  await writeArtifact("out.json", { scored });
  return { best: ranked.ranked[0] };
};
`,
	);
	await writeWorkflow(project, "lib/rank-globals", RANK_CHILD_GLOBALS);

	const graph = await graphOf(url, project, "graph-globals");
	check(
		"globals: parser detects calls (graph is NOT the empty message)",
		!/workflow API calls detected/i.test(graph),
		graph.slice(0, 500),
	);
	check("globals: fan-out subagents step detected", /fan-out subagents/i.test(graph), graph);
	check("globals: bare agent() subagent step detected", /\bsubagent\b/i.test(graph), graph);
	check("globals: sub-workflow compose detected", /sub-workflow/i.test(graph), graph);
	check(
		"globals: literal child expanded one level",
		/expands:\s*lib\/rank-globals\s*\(\d+ steps\)/.test(graph),
		graph,
	);
	// Precisión: las llamadas estilo globals (parent Y child son globals acá) NO deben quedar mal etiquetadas con un
	// prefijo `ctx.` en las líneas de step renderizadas.
	check("globals: steps are NOT mislabeled with a ctx. prefix", !/ctx\./.test(graph), graph);
}

async function main() {
	try {
		const { url } = await buildExtension();
		await scenarioLiteralExpansion(url);
		await scenarioGlobalsStyleDetected(url);
		await scenarioDynamicName(url);
		await scenarioDepthLimit(url);
		await scenarioRecursionGuard(url);
		await scenarioUnresolvable(url);
		await scenarioCommentIgnored(url);
		console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
		if (counts.failed) {
			console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
			process.exit(1);
		}
		process.exit(0);
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

await main();
