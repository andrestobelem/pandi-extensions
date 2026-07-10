/**
 * Test de contrato conductual: el monitor muestra QUÉ MODEL y EFFORT usó cada subagente.
 *
 * Hallazgo: el model/thinking efectivo de un subagente solo se resolvía dentro de
 * buildAgentArgs (index.ts) y nunca se persistía: ni en los eventos `agent` de events.jsonl,
 * ni en SubagentResult, ni en AgentMonitorModel. Por eso, el dashboard no podía
 * mostrarlo y los post-mortems no podían distinguir un scout haiku de un judge opus.
 *
 * Esto pinea el nuevo contrato end-to-end:
 *  1. ENGINE: un run agent() real journalea el model/thinking resuelto en
 *     SubagentResult, los eventos agent de events.jsonl y el artifact .md.
 *  2. PARSER: readRunEvents levanta model/thinking a AgentMonitorModel y
 *     mergeAgentMonitor los preserva entre merges de eventos.
 *  3. DASHBOARD: las filas de agentes llevan chips `model:` / `effort:` (omitidos si se desconocen)
 *     y el detail de Selected agent renderiza una línea `model: … • effort: …`,
 *     byte-idéntica entre las tabs Monitor y Agents.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/runtime/agent-model-effort.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createChecker,
	loadModule,
	sdkStub,
	buildExtension as sharedBuildExtension,
} from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const { check, counts } = createChecker();

const MODEL = "prov/mod-x";
const THINKING = "high";

// ---------------------------------------------------------------------------
// Escenario 1: engine end-to-end — agent() persiste model/thinking resuelto.
// ---------------------------------------------------------------------------

const WORKFLOW = [
	"export const meta = { name: 'model-effort', description: 'model/effort observability', phases: [{ title: 'P' }] };",
	"phase('P');",
	`const [r] = await agents([{ prompt: 'say hi', name: 'modeled', model: ${JSON.stringify(MODEL)}, thinking: ${JSON.stringify(THINKING)}, cache: false }], { settle: true });`,
	// Issue #22: effort por item en la ruta host agents() debe respetarse (max -> xhigh).
	"const [e] = await agents([{ prompt: 'say effort', name: 'efforted', effort: 'max', cache: false }], { settle: true });",
	// El effort de opción compartida aplica a cada item.
	"const [s] = await agents([{ prompt: 'say shared', name: 'shared-effort', cache: false }], { settle: true, effort: 'high' });",
	// El thinking explícito gana cuando se dan ambos (espeja el agent() global del worker).
	"const [w] = await agents([{ prompt: 'say both', name: 'both', effort: 'low', thinking: 'high', cache: false }], { settle: true });",
	// El effort explícito por item overridea el thinking default de una persona (reviewer = high).
	"const [p] = await agents([{ prompt: 'say persona', name: 'persona-effort', agentType: 'reviewer', effort: 'low', cache: false }], { settle: true });",
	// Issue #23: label por item en la ruta host agents() se vuelve el nombre del subagente.
	"const [l] = await agents([{ prompt: 'say label', label: 'scout-x', cache: false }], { settle: true });",
	"return { model: r?.model ?? null, thinking: r?.thinking ?? null, ok: r?.ok ?? null, effortThinking: e?.thinking ?? null, sharedThinking: s?.thinking ?? null, bothThinking: w?.thinking ?? null, personaThinking: p?.thinking ?? null, labeledName: l?.name ?? null };",
].join("\n");

async function buildEngine() {
	return await sharedBuildExtension({
		name: "pi-dw-model-effort",
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

function makePi() {
	const tools = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools };
}

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-model-effort-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "model-effort.js"), `${WORKFLOW}\n`, "utf8");
	// `pi` fake: emitir un message_end y exit 0 (agente exitoso e instantáneo).
	const event = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1 } },
	});
	const fakePi = path.join(project, "fake-pi.mjs");
	await fs.writeFile(fakePi, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${event}\n`)});\n`, {
		mode: 0o755,
	});
	const wrapper = path.join(project, "pi-wrapper.sh");
	await fs.writeFile(
		wrapper,
		`#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePi)} "$@"\n`,
		{ mode: 0o755 },
	);
	return { project, wrapper };
}

async function scenarioEngine() {
	const { url } = await buildEngine();
	const mod = await import(url);
	const ext = mod.default;
	const { project, wrapper } = await makeProject();
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = wrapper;

	let result;
	let executeError;
	try {
		const res = await tool.execute(
			"tc-model-effort",
			{ action: "run", name: "model-effort", input: {}, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		result = res?.details?.result;
	} catch (err) {
		executeError = err instanceof Error ? err.message : String(err);
	}
	const out = result?.output;

	check("engine: run completes", result?.ok === true, executeError ?? result?.error);
	check("engine: SubagentResult.model carries the resolved model", out?.model === MODEL, JSON.stringify(out));
	check(
		"engine: SubagentResult.thinking carries the resolved effort",
		out?.thinking === THINKING,
		JSON.stringify(out),
	);
	check(
		"engine: per-item effort on agents() maps to thinking (max -> xhigh)",
		out?.effortThinking === "xhigh",
		JSON.stringify(out),
	);
	check(
		"engine: shared-option effort on agents() maps to thinking",
		out?.sharedThinking === "high",
		JSON.stringify(out),
	);
	check(
		"engine: explicit thinking wins over effort when both are given",
		out?.bothThinking === "high",
		JSON.stringify(out),
	);
	check(
		"engine: explicit per-item effort overrides the persona thinking default",
		out?.personaThinking === "low",
		JSON.stringify(out),
	);
	check(
		"engine: per-item label on agents() becomes the subagent name",
		out?.labeledName === "scout-x",
		JSON.stringify(out),
	);

	// events.jsonl: tanto el evento start (running) como el end llevan model/thinking.
	let events = [];
	let md = "";
	let runDir = "";
	try {
		const runsDir = path.join(project, ".pi", "workflows", "runs");
		runDir = path.join(runsDir, (await fs.readdir(runsDir))[0]);
		const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
		events = body
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		const agentsDir = path.join(runDir, "agents");
		const mdName = (await fs.readdir(agentsDir)).find((f) => f.endsWith("-modeled.md"));
		md = await fs.readFile(path.join(agentsDir, mdName), "utf8");
	} catch {
		// events/md quedan vacíos; los checks fallan con evidencia
	}
	const agentEvents = events.filter((e) => e.type === "agent");
	const startEvent = agentEvents.find((e) => e.state === "running" && e.name === "modeled");
	const endEvent = agentEvents.find((e) => (e.state === "completed" || e.state === "failed") && e.name === "modeled");
	check(
		"engine: agent START event carries model + thinking",
		startEvent?.model === MODEL && startEvent?.thinking === THINKING,
		JSON.stringify(startEvent),
	);
	check(
		"engine: agent END event carries model + thinking",
		endEvent?.model === MODEL && endEvent?.thinking === THINKING,
		JSON.stringify(endEvent),
	);
	check(`engine: artifact records "- model: ${MODEL}"`, md.includes(`- model: ${MODEL}`), md.split("\n")[0]);
	check(
		`engine: artifact records "- thinking: ${THINKING}"`,
		md.includes(`- thinking: ${THINKING}`),
		md.split("\n").slice(0, 8).join(" | "),
	);
	const effortedStart = agentEvents.find((e) => e.state === "running" && e.name === "efforted");
	check(
		"engine: efforted agent START event carries the mapped thinking",
		effortedStart?.thinking === "xhigh",
		JSON.stringify(effortedStart),
	);

	// Round-trip del parser sobre el run dir REAL: el modelo de monitor lleva model/thinking.
	const parsed = await mod.readRunEvents(runDir);
	const monitored = parsed.agents.find((a) => a.name === "modeled");
	check(
		"parser: readRunEvents lifts model/thinking from a real run",
		monitored?.model === MODEL && monitored?.thinking === THINKING,
		JSON.stringify(monitored),
	);

	// mergeAgentMonitor: los valores sobreviven un patch posterior sin ellos, y un patch puede setearlos.
	const kept = mod.mergeAgentMonitor(
		{ id: 1, name: "a", state: "running", model: MODEL, thinking: THINKING },
		{ id: 1, name: "a", state: "completed" },
	);
	check(
		"parser: mergeAgentMonitor preserves model/thinking across merges",
		kept.model === MODEL && kept.thinking === THINKING,
		JSON.stringify(kept),
	);
	const set = mod.mergeAgentMonitor(
		{ id: 1, name: "a", state: "running" },
		{
			id: 1,
			name: "a",
			state: "running",
			model: MODEL,
			thinking: THINKING,
		},
	);
	check(
		"parser: mergeAgentMonitor applies model/thinking from a patch",
		set.model === MODEL && set.thinking === THINKING,
		JSON.stringify(set),
	);
}

// ---------------------------------------------------------------------------
// Escenario 2: dashboard — chips de fila + línea de detail de Selected agent.
// ---------------------------------------------------------------------------

const theme = { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v };
const WIDTH = 10000;

function makeAgent(overrides = {}) {
	return {
		id: 1,
		name: "scout",
		state: "completed",
		elapsedMs: 4200,
		code: 0,
		promptAvailable: true,
		artifactPath: "agent-1/output.md",
		...overrides,
	};
}

function makeRun() {
	const now = Date.now();
	return {
		workflow: "demo-flow",
		scope: "project",
		file: "/nonexistent/demo-flow.js",
		runId: "run-1234567890abcd",
		runDir: "/tmp/nonexistent-run-dir",
		ok: true,
		state: "completed",
		startedAt: new Date(now - 60000).toISOString(),
		endedAt: new Date(now).toISOString(),
		elapsedMs: 60000,
		agentCount: 1,
		agentConcurrency: 2,
		parallelAgents: 1,
		peakParallelAgents: 1,
		logs: [],
	};
}

function makeMonitorModel(run, agent) {
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state: "completed",
		active: false,
		stale: false,
		elapsedMs: 60000,
		agentsStarted: 1,
		agentsDone: 1,
		parallelAgents: 1,
		peakParallelAgents: 1,
		agentConcurrency: 2,
		bashDone: 0,
		artifactCount: 1,
		agents: [agent],
		runDir: run.runDir,
		priority: "latest",
		canCancel: false,
		canRerun: false,
	};
}

function agentRow(lines) {
	return lines.find((l) => l.includes("prompt✓"));
}

function detailField(lines, label) {
	const idx = lines.findIndex((l) => l.trim() === "Selected agent");
	if (idx < 0) return undefined;
	return lines.slice(idx + 1).find((l) => l.trimStart().startsWith(`${label}: `));
}

async function scenarioDashboard() {
	const { url } = await sharedBuildExtension({
		name: "pi-dwf-model-effort-dashboard",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "tui/dashboard.ts"),
		outName: "workflow-dashboard.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	const { WorkflowDashboard } = await loadModule(url);
	check("dashboard: WorkflowDashboard class is exported", typeof WorkflowDashboard === "function");

	const build = (initialTab, agentOverrides) => {
		const agent = makeAgent(agentOverrides);
		const run = makeRun();
		return new WorkflowDashboard(
			[],
			[run],
			[],
			[],
			[makeMonitorModel(run, agent)],
			[{ run, agent }],
			theme,
			() => {},
			() => {},
			initialTab,
		);
	};

	const withModel = { model: "anthropic/claude-sonnet-4-5", thinking: "high" };
	const monitorLines = build("monitor", withModel).render(WIDTH);
	const agentsLines = build("agents", withModel).render(WIDTH);

	// Chips de fila: model corto (último segmento de path) + effort, presentes en AMBAS tabs.
	for (const [tab, lines] of [
		["Monitor", monitorLines],
		["Agents", agentsLines],
	]) {
		const row = agentRow(lines);
		check(
			`dashboard: ${tab} row carries the model chip (short id)`,
			typeof row === "string" && row.includes("model:claude-sonnet-4-5"),
			JSON.stringify(row),
		);
		check(
			`dashboard: ${tab} row carries the effort chip`,
			typeof row === "string" && row.includes("effort:high"),
			JSON.stringify(row),
		);
	}

	// Detail de Selected agent: model completo + effort en una línea, byte-idéntico entre tabs.
	const monitorModelLine = detailField(monitorLines, "model");
	const agentsModelLine = detailField(agentsLines, "model");
	check(
		"dashboard: detail model line shows full model and effort",
		typeof monitorModelLine === "string" &&
			monitorModelLine.includes("anthropic/claude-sonnet-4-5") &&
			monitorModelLine.includes("effort: high"),
		JSON.stringify(monitorModelLine),
	);
	check(
		"dashboard: detail model line is byte-identical across Monitor and Agents",
		monitorModelLine !== undefined && monitorModelLine === agentsModelLine,
		`monitor=${JSON.stringify(monitorModelLine)} agents=${JSON.stringify(agentsModelLine)}`,
	);

	// Model/effort desconocidos (runs viejos): los chips se OMITEN, detail cae a `default`.
	const bareRow = agentRow(build("monitor", {}).render(WIDTH));
	check(
		"dashboard: row omits model/effort chips when unknown",
		typeof bareRow === "string" && !bareRow.includes("model:") && !bareRow.includes("effort:"),
		JSON.stringify(bareRow),
	);
	const bareDetail = detailField(build("monitor", {}).render(WIDTH), "model");
	check(
		"dashboard: detail model line falls back to default when unknown",
		typeof bareDetail === "string" && bareDetail.includes("model: default") && bareDetail.includes("effort: default"),
		JSON.stringify(bareDetail),
	);
}

async function main() {
	await scenarioEngine();
	await scenarioDashboard();

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
