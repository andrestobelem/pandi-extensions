/**
 * Behavioral contract test: bare tier aliases (haiku/sonnet/opus) survive
 * non-Anthropic sessions (#24).
 *
 * Finding: the runtime pins a bare alias to the session provider on spawn
 * (--provider <session> --model <alias>), which resolves on Anthropic but fails
 * fast on providers whose catalog has no such alias (verified empirically:
 * `--provider openai-codex --model haiku` → "model is not supported", exit 1).
 * So the scaffolds' cheap/balanced/deep tiering silently degraded to "every
 * tiered branch fails" cross-provider.
 *
 * This pins the per-provider tier table:
 *  1. In an openai-codex session, haiku/sonnet/opus map to the provider's
 *     cheap/balanced/deep ids (gpt-5.4-mini / gpt-5.4 / gpt-5.5), the mapping is
 *     confirmed against ctx.modelRegistry, recorded on the SubagentResult, and
 *     logged.
 *  2. Qualified provider/id models and omitted models are untouched.
 *  3. If the registry does NOT confirm the mapped id (catalog moved), the alias
 *     is pinned verbatim (today's fail-fast behavior) with a warning log — the
 *     session model is NEVER silently substituted.
 *  4. Providers without a table entry (anthropic) keep today's verbatim pinning.
 *  5. PI_DYNAMIC_WORKFLOWS_TIER_MODELS (JSON) overrides/extends the builtin table.
 *  6. Resume-cache stability: the cache key sees the RAW alias (mapping happens
 *     after key computation), so a completed run resumes with cached agents even
 *     when the registry stops confirming the mapping.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/tier-alias-mapping.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const CODEX_IDS = new Set(["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"]);

async function buildEngine() {
	return await sharedBuildExtension({
		name: "pi-dw-tier-alias",
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

function makeCtx(cwd, { provider, registryIds } = {}) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		...(provider ? { model: { provider, id: "session-model" } } : {}),
		...(registryIds
			? {
					modelRegistry: {
						find: (p, id) => (registryIds.has(`${p}/${id}`) ? { provider: p, id } : undefined),
					},
				}
			: {}),
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

async function makeProject(workflowSource) {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-tier-alias-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "tiered.js"), `${workflowSource}\n`, "utf8");
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

async function runWorkflow(tool, project, wrapper, ctxOptions, params) {
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = wrapper;
	const ctx = makeCtx(project, ctxOptions);
	let result;
	let executeError;
	try {
		const res = await tool.execute(
			`tc-tier-${Math.random().toString(36).slice(2, 8)}`,
			{ action: "run", name: "tiered", input: {}, timeoutMs: 30_000, ...params },
			new AbortController().signal,
			undefined,
			ctx,
		);
		result = res?.details?.result;
	} catch (err) {
		executeError = err instanceof Error ? err.message : String(err);
	}
	return { result, executeError, ctx };
}

async function readRun(project) {
	const runsDir = path.join(project, ".pi", "workflows", "runs");
	const runId = (await fs.readdir(runsDir)).sort()[0];
	const runDir = path.join(runsDir, runId);
	const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	const events = body
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
	return { runId, runDir, events };
}

const THREE_TIER_WORKFLOW = [
	"export const meta = { name: 'tiered', description: 'tier alias mapping', phases: [{ title: 'P' }] };",
	"phase('P');",
	"const rs = await agents([",
	"  { prompt: 'say cheap', name: 'cheap', model: 'haiku', cache: false },",
	"  { prompt: 'say balanced', name: 'balanced', model: 'sonnet', cache: false },",
	"  { prompt: 'say deep', name: 'deep', model: 'opus', cache: false },",
	"  { prompt: 'say qualified', name: 'qualified', model: 'anthropic/claude-haiku-4-5', cache: false },",
	"  { prompt: 'say inherited', name: 'inherited', cache: false },",
	"], { settle: true });",
	"return { models: rs.map((r) => r?.model ?? null) };",
].join("\n");

async function main() {
	const { url } = await buildEngine();
	const mod = await import(url);
	const ext = mod.default;

	const codexRegistry = new Set([...CODEX_IDS].map((id) => `openai-codex/${id}`));

	// --- 1+2) codex session: tier aliases map (registry-confirmed); qualified/omitted untouched.
	{
		const { project, wrapper } = await makeProject(THREE_TIER_WORKFLOW);
		const { pi, tools } = makePi();
		(ext.activate ?? ext)(pi, makeCtx(project, { provider: "openai-codex", registryIds: codexRegistry }));
		const { result, executeError } = await runWorkflow(tools.get("dynamic_workflow"), project, wrapper, {
			provider: "openai-codex",
			registryIds: codexRegistry,
		});
		const models = result?.output?.models;
		check("codex: run completes", result?.ok === true, executeError ?? result?.error);
		check(
			"codex: haiku maps to the provider's cheap tier",
			models?.[0] === "openai-codex/gpt-5.4-mini",
			JSON.stringify(models),
		);
		check(
			"codex: sonnet maps to the provider's balanced tier",
			models?.[1] === "openai-codex/gpt-5.4",
			JSON.stringify(models),
		);
		check(
			"codex: opus maps to the provider's deep tier",
			models?.[2] === "openai-codex/gpt-5.5",
			JSON.stringify(models),
		);
		check(
			"codex: qualified provider/id is untouched",
			models?.[3] === "anthropic/claude-haiku-4-5",
			JSON.stringify(models),
		);
		check(
			"codex: omitted model inherits the session model untouched",
			models?.[4] === "openai-codex/session-model",
			JSON.stringify(models),
		);
		const { events } = await readRun(project);
		const mapLog = events.find((e) => e.type === "log" && /tier alias mapped/.test(e.message ?? ""));
		check(
			"codex: the mapping is logged",
			!!mapLog,
			JSON.stringify(events.filter((e) => e.type === "log").slice(0, 6)),
		);
		const cheapStart = events.find((e) => e.type === "agent" && e.name === "cheap" && e.state === "running");
		check(
			"codex: the agent START event records the mapped model",
			cheapStart?.model === "openai-codex/gpt-5.4-mini",
			JSON.stringify(cheapStart),
		);
	}

	// --- 3) registry does NOT confirm the mapped id -> verbatim pin + warning, never the session model.
	{
		const { project, wrapper } = await makeProject(THREE_TIER_WORKFLOW);
		const { pi, tools } = makePi();
		const emptyRegistry = new Set();
		(ext.activate ?? ext)(pi, makeCtx(project, { provider: "openai-codex", registryIds: emptyRegistry }));
		const { result } = await runWorkflow(tools.get("dynamic_workflow"), project, wrapper, {
			provider: "openai-codex",
			registryIds: emptyRegistry,
		});
		const models = result?.output?.models;
		check(
			"unconfirmed: alias pinned verbatim (fail-fast preserved), not silently substituted",
			models?.[0] === "openai-codex/haiku",
			JSON.stringify(models),
		);
		const { events } = await readRun(project);
		const warnLog = events.find((e) => e.type === "log" && /tier alias not confirmed/.test(e.message ?? ""));
		check(
			"unconfirmed: a warning is logged",
			!!warnLog,
			JSON.stringify(events.filter((e) => e.type === "log").length),
		);
	}

	// --- 4) anthropic session (no table entry): verbatim pinning as today.
	{
		const { project, wrapper } = await makeProject(THREE_TIER_WORKFLOW);
		const { pi, tools } = makePi();
		(ext.activate ?? ext)(pi, makeCtx(project, { provider: "anthropic" }));
		const { result } = await runWorkflow(tools.get("dynamic_workflow"), project, wrapper, { provider: "anthropic" });
		const models = result?.output?.models;
		check(
			"anthropic: alias keeps today's verbatim provider pinning",
			models?.[0] === "anthropic/haiku",
			JSON.stringify(models),
		);
	}

	// --- 5) env override extends/overrides the builtin table.
	{
		const { project, wrapper } = await makeProject(THREE_TIER_WORKFLOW);
		const { pi, tools } = makePi();
		const customRegistry = new Set(["openai-codex/gpt-9-mini", ...codexRegistry]);
		process.env.PI_DYNAMIC_WORKFLOWS_TIER_MODELS = JSON.stringify({ "openai-codex": { haiku: "gpt-9-mini" } });
		try {
			(ext.activate ?? ext)(pi, makeCtx(project, { provider: "openai-codex", registryIds: customRegistry }));
			const { result } = await runWorkflow(tools.get("dynamic_workflow"), project, wrapper, {
				provider: "openai-codex",
				registryIds: customRegistry,
			});
			const models = result?.output?.models;
			check(
				"env override: haiku maps to the custom id",
				models?.[0] === "openai-codex/gpt-9-mini",
				JSON.stringify(models),
			);
			check(
				"env override: unoverridden tiers keep the builtin mapping",
				models?.[1] === "openai-codex/gpt-5.4",
				JSON.stringify(models),
			);
		} finally {
			delete process.env.PI_DYNAMIC_WORKFLOWS_TIER_MODELS;
		}
	}

	// --- 6) resume-cache stability: the key sees the RAW alias, so a completed run
	//        resumes with cached agents even when the registry stops confirming.
	{
		const CACHED_WORKFLOW = [
			"export const meta = { name: 'tiered', description: 'tier alias cache', phases: [{ title: 'P' }] };",
			"phase('P');",
			"const [r] = await agents([{ prompt: 'say cached', name: 'cached-node', model: 'haiku' }], { settle: true });",
			"return { model: r?.model ?? null };",
		].join("\n");
		const { project, wrapper } = await makeProject(CACHED_WORKFLOW);
		const { pi, tools } = makePi();
		(ext.activate ?? ext)(pi, makeCtx(project, { provider: "openai-codex", registryIds: codexRegistry }));
		const first = await runWorkflow(tools.get("dynamic_workflow"), project, wrapper, {
			provider: "openai-codex",
			registryIds: codexRegistry,
		});
		check("cache: first run completes", first.result?.ok === true, first.executeError ?? first.result?.error);
		const { runId } = await readRun(project);
		// Resume with a registry that no longer confirms the mapping: the journal must
		// still HIT (key = raw alias), so the agent is replayed as cached, not re-run.
		const resumed = await runWorkflow(
			tools.get("dynamic_workflow"),
			project,
			wrapper,
			{
				provider: "openai-codex",
				registryIds: new Set(),
			},
			{ action: "resume", name: runId, force: true },
		);
		check("cache: resume completes", resumed.result?.ok === true, resumed.executeError ?? resumed.result?.error);
		const { events } = await readRun(project);
		const cachedEvent = events.find((e) => e.type === "agent" && e.name === "cached-node" && e.state === "cached");
		check(
			"cache: resumed agent replays from the journal (state=cached) despite the registry change",
			!!cachedEvent,
			JSON.stringify(events.filter((e) => e.type === "agent").map((e) => ({ name: e.name, state: e.state }))),
		);
	}

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
