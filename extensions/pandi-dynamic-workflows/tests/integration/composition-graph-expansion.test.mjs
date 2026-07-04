/**
 * Durable behavioral integration test for the STATIC sub-workflow expansion in the workflow GRAPH
 * (`dynamic_workflow action="graph"`) of extensions/pandi-dynamic-workflows/index.ts.
 *
 * This is the STATIC analogue of dynamic-workflow-composition.test.mjs. That suite (and
 * passes 5/6) only exercise composition at RUNTIME (action="run"/"resume" → runSubworkflow).
 * NOBODY exercised the STATIC graph that expands ctx.workflow("name") one level by reading
 * the child file at preview time. That surface was introduced by commits:
 *   - ccc51ca "feat(dynamic-workflows): expand subworkflows in workflow graphs"
 *   - 907f0c2 "fix(dynamic-workflows): ignore comments when graphing workflow calls"
 * via buildWorkflowGraphModelWithSubworkflows (dynamic-workflows.ts ~:2527) → makeWorkflowGraphForContext.
 * A silent regression here is invisible to tsc (string parsing + file resolution + render).
 *
 * Six OBSERVABLE contracts pinned (all surfaced in `details.graph` / content text of action=graph):
 *   1. Literal happy path: ctx.workflow("lib/rank-candidates") with a LITERAL name resolves the
 *      child file, parses it, and the graph contains `expands: <name> (<n> steps)` plus the
 *      child's sub-graph lines (renderWorkflowGraphSubworkflowSummaryLines).
 *   2. Dynamic name: ctx.workflow(someVar) is NOT resolved →
 *      "dynamic sub-workflow name; cannot resolve statically".
 *   3. Depth limit: a child that itself calls ctx.workflow(...) (grandchild) is not expanded →
 *      "nested sub-workflows are not expanded; runtime composition depth limit is 1".
 *   4. Recursion guard: a workflow that calls ITSELF (ctx.workflow("<own name>")) → at depth 0 the
 *      resolved path is already in `seen` → "recursive sub-workflow skipped: <name>". (A deeper cycle
 *      hits the depth-limit message first, so the guard is exercised at the depth-0 self-call.)
 *   5. Unresolvable literal: ctx.workflow("does-not-exist") → resolve throws, caught into
 *      subworkflowError "Workflow not found: does-not-exist".
 *   6. Comment-ignoring (907f0c2): a ctx.workflow(...) inside a // line or block comment is NOT
 *      detected as a sub-workflow step at all.
 *
 * The graph only PARSES the child's source; it never executes it, so the child workflows can be
 * minimal source files. They are installed into a temp project's .pi/workflows/{,lib/} exactly as
 * the runtime resolves them, and we drive the REAL dynamic_workflow tool with action="graph".
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/composition-graph-expansion.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-graph-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
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

// Run action=graph for `name` and return the rendered graph text (same string the agent/user sees).
async function graphOf(url, project, name) {
	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	const response = await runTool(tools.get("dynamic_workflow"), ctx, { action: "graph", name });
	const fromDetails = response?.details?.graph;
	const fromContent = response?.content?.[0]?.text;
	// Both surfaces must carry the same graph string (regression guard on the response shape).
	if (typeof fromDetails === "string" && typeof fromContent === "string") {
		check(`graph[${name}]: details.graph === content text`, fromDetails === fromContent);
	}
	return fromDetails ?? fromContent ?? "";
}

// A minimal child library workflow: two ctx.* steps, no nested ctx.workflow.
const RANK_CHILD = `
module.exports = async function workflow(ctx, input) {
  const scored = await ctx.agents(input.candidates.map((c) => ({ prompt: "score " + c })), { name: "juror" });
  await ctx.writeArtifact("ranked.json", { scored });
  return { ranked: scored };
};
`;

// 1. Literal happy path: parent calls a literal lib/ child; the child must be expanded inline.
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
	// The child's own steps (agents/writeArtifact) must appear inside the expanded subgraph.
	check(
		"literal: child fan-out step surfaced in subgraph",
		/ctx\.agents/.test(graph) && /ctx\.workflow/.test(graph),
		graph,
	);
	check("literal: child artifact step surfaced in subgraph", /ctx\.writeArtifact/.test(graph), graph);
	check("literal: emits the expansion note", /literal names are expanded one level/i.test(graph), graph);
	check("literal: no 'subgraph unavailable' for the resolvable child", !/subgraph unavailable/.test(graph), graph);
}

// 2. Dynamic name: ctx.workflow(variable) cannot be resolved statically.
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

// 3. Depth limit: child resolves, but its own ctx.workflow grandchild is not expanded (depth >= 1).
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

// 4. Recursion guard: a workflow that calls ITSELF. At depth 0, the resolved self-path is already
//    in `seen`, so the seen-based guard fires (NOT the depth-limit branch — that only triggers at
//    depth >= 1, i.e. one level deeper). This pins the distinct recursive-skip message.
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
	// Critically NOT the depth-limit message: the seen-guard must win for a depth-0 self-call.
	check("recursion: not mislabeled as depth-limit", !/depth limit is 1/.test(graph), graph);
	check("recursion: does not infinitely inline itself", !/expands:\s*graph-recur/.test(graph), graph);
}

// 5. Unresolvable literal: ctx.workflow("does-not-exist") → resolve throws, caught into subworkflowError.
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

// 6. Comment-ignoring (907f0c2): ctx.workflow(...) inside comments must NOT be graphed.
async function scenarioCommentIgnored(url) {
	const project = await makeProject();
	// Only commented-out ctx.workflow calls; the live body has a single real ctx.agent.
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
	// Resolvable target exists, so if a commented call WERE graphed it would even expand — making
	// the bug loud. The contract: it must not be detected at all.
	await writeWorkflow(project, "lib/rank-candidates", RANK_CHILD);

	const graph = await graphOf(url, project, "graph-commented");
	check("comments: commented ctx.workflow is NOT detected as a sub-workflow", !/sub-workflow/i.test(graph), graph);
	check("comments: does not expand the commented child", !/expands:\s*lib\/rank-candidates/.test(graph), graph);
	check("comments: the real ctx.agent step IS present", /ctx\.agent\b/.test(graph), graph);

	// Positive control: an IDENTICAL workflow with the call UNcommented DOES expand → proves the
	// negative above is caused by the comment, not by some unrelated parse failure.
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

// A globals-style child library workflow (export default main() + injected globals, no ctx.*).
const RANK_CHILD_GLOBALS = `
export default async function main() {
  const scored = await agents(args.candidates.map((c) => ({ prompt: "score " + c })), { name: "juror" });
  await writeArtifact("ranked.json", { scored });
  return { ranked: scored };
};
`;

// Globals-style parent: bare agent()/agents()/workflow()/writeArtifact() calls (no ctx.*). The
// graph parser must detect these exactly like ctx.* calls; previously it only matched `ctx.<m>(`,
// so a globals-style workflow rendered an EMPTY graph ("No ... workflow API calls detected").
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
	// Accuracy: globals-style calls (parent AND child are globals here) must NOT be mislabeled with a
	// `ctx.` prefix in the rendered step lines.
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
