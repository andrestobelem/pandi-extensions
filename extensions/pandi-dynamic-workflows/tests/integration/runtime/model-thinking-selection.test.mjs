/**
 * Test de integración conductual durable que prueba que un dynamic workflow puede decidir, POR
 * LLAMADA, qué model/provider usar y con qué nivel de thinking (reasoning) lanzar
 * cada subagente.
 *
 * Esto pinea el contrato de cara al usuario:
 *   - ctx.agent(prompt, { model, thinking })   -> spawnea `pi --model <m> --thinking <t>`.
 *   - ctx.agent(prompt, { provider, thinking }) -> spawnea `pi --provider <p> --thinking <t>`
 *                                                  SIN un --model (branch provider-only).
 *   - ctx.agents([{ prompt, model, thinking }, { prompt }]) -> override model/thinking
 *     por spec en un branch; el otro branch HEREDA el modelo del orquestador
 *     (ctx.model -> `provider/id`) y el thinking level de la sesión
 *     (pi.getThinkingLevel()).
 *
 * Self-bootstrapping: esbuild de la extensión ACTUAL a un tempdir (nunca stale),
 * con alias typebox/SDK/tui a stubs locales para que corra sin `npm install`. El
 * frontera del subprocess de agente se fakea vía PI_DYNAMIC_WORKFLOWS_PI_COMMAND: un script node
 * mínimo que (a) registra su argv completo en un archivo JSON por llamada keyeado por un
 * marcador embebido en el prompt y (b) emite una línea message_update JSON-mode para que
 * el resultado del agente parsee. No se llama ningún modelo real.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/model-thinking-selection.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

// Workflow bajo test: hace cuatro llamadas de agente con intención model/thinking distinta.
// Cada prompt lleva un marcador CALL_* que el `pi` fake usa para nombrar su record argv.
const WORKFLOW = [
	"module.exports = async function workflow(ctx, input) {",
	"  const a = await ctx.agent('CALL_A scout', { name: 'a', model: 'test-prov/model-a', thinking: 'high', tools: ['read'] });",
	"  const b = await ctx.agent('CALL_B classify', { name: 'b', provider: 'test-prov', thinking: 'low', tools: ['read'] });",
	"  const c = await ctx.agents([",
	"    { name: 'c1', prompt: 'CALL_C1 synth', model: 'test-prov/model-c1', thinking: 'xhigh', tools: ['read'] },",
	"    { name: 'c2', prompt: 'CALL_C2 inherit', tools: ['read'] },",
	"  ], { concurrency: 2 });",
	"  const d = await ctx.agent('CALL_D bare-alias', { name: 'd', model: 'sonnet', thinking: 'medium', tools: ['read'] });",
	"  return { a: a.output, b: b.output, c: c.map((r) => (r ? r.output : null)), d: d.output };",
	"};",
	"",
].join("\n");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-model-thinking-integration",
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
		// Thinking level de sesión que el workflow debe HEREDAR cuando una llamada omite `thinking`.
		getThinkingLevel: () => "medium",
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
		// Modelo del orquestador que el workflow debe HEREDAR cuando una llamada omite model/provider.
		model: { provider: "ctx-prov", id: "ctx-model" },
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-model-thinking-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-integration", params, new AbortController().signal, undefined, ctx);
}

// Subprocess de agente `pi` fake. Registra su argv completo en <RECORD_DIR>/<marker>.json,
// donde <marker> es el token CALL_* del prompt (último argv), luego emite un
// message_update JSON-mode para que el resultado del agente parsee.
async function writeFakePi(outDir, recordDir) {
	const fakePi = path.join(outDir, `fake-pi-${instance}.mjs`);
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
const m = /CALL_[A-Z0-9]+/.exec(prompt);
const marker = m ? m[0] : "UNKNOWN-" + Date.now();
fs.writeFileSync(path.join(${JSON.stringify(recordDir)}, marker + ".json"), JSON.stringify(argv));
process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "ok:" + marker }] } }) + "\\n");
`,
		{ mode: 0o700 },
	);
	return fakePi;
}

async function withFakePi(fakePi, fn) {
	const old = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	try {
		return await fn();
	} finally {
		if (old === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = old;
	}
}

function flagValue(args, flag) {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(args, flag) {
	return args.includes(flag);
}

async function main() {
	try {
		const { outDir, url } = await buildExtension();
		const recordDir = path.join(outDir, "argv");
		await fs.mkdir(recordDir, { recursive: true });
		const project = await makeProject();
		await fs.writeFile(path.join(project, ".pi", "workflows", "model-thinking.js"), WORKFLOW, "utf8");
		const fakePi = await writeFakePi(outDir, recordDir);

		const result = await withFakePi(fakePi, async () => {
			const ext = await freshExtension(url);
			const { pi, tools } = makePi();
			ext(pi);
			// #3.4 (research §3e): la tool debe enseñar un prefijo de prompt KV-cache estable
			// (framing compartido primero, contenido volátil por item al final) para que prefijos idénticos
			// reutilicen la prompt/KV cache del provider entre llamadas.
			const guide = (tools.get("dynamic_workflow").promptGuidelines ?? []).join("\n");
			check(
				"promptGuidelines: teaches stable KV-cache prefix (stable framing first, volatile content to the END)",
				/(stable prefix|prefijo estable)/i.test(guide) &&
					/(provider prompt\/KV cache|prompt\/KV cache del provider)/i.test(guide) &&
					/(to the END|al FINAL)/.test(guide),
				guide.slice(0, 240),
			);
			const ctx = makeCtx(project);
			const response = await runTool(tools.get("dynamic_workflow"), ctx, {
				action: "run",
				name: "model-thinking",
				input: {},
				maxAgents: 20,
				concurrency: 2,
				timeoutMs: 60_000,
			});
			return response.details.result;
		});

		check("workflow run succeeds", result.ok === true, result.error);
		if (result.ok !== true) {
			finish();
			return;
		}

		const readArgv = async (marker) => JSON.parse(await fs.readFile(path.join(recordDir, `${marker}.json`), "utf8"));

		// CALL_A: model + thinking explícitos ganan.
		const a = await readArgv("CALL_A");
		check("A: explicit model passed as --model", flagValue(a, "--model") === "test-prov/model-a", JSON.stringify(a));
		check("A: explicit thinking passed as --thinking", flagValue(a, "--thinking") === "high", JSON.stringify(a));

		// CALL_B: branch provider-only -> --provider seteado, NO se sintetiza --model.
		const b = await readArgv("CALL_B");
		check("B: explicit provider passed as --provider", flagValue(b, "--provider") === "test-prov", JSON.stringify(b));
		check("B: provider-only call omits --model", hasFlag(b, "--model") === false, JSON.stringify(b));
		check("B: explicit thinking passed as --thinking", flagValue(b, "--thinking") === "low", JSON.stringify(b));

		// CALL_C1: override por spec dentro de ctx.agents().
		const c1 = await readArgv("CALL_C1");
		check(
			"C1: per-spec model passed as --model",
			flagValue(c1, "--model") === "test-prov/model-c1",
			JSON.stringify(c1),
		);
		check("C1: per-spec thinking passed as --thinking", flagValue(c1, "--thinking") === "xhigh", JSON.stringify(c1));

		// CALL_C2: hereda modelo de ctx + thinking de sesión cuando se omiten.
		const c2 = await readArgv("CALL_C2");
		check(
			"C2: inherits orchestrator model (ctx.model -> provider/id)",
			flagValue(c2, "--model") === "ctx-prov/ctx-model",
			JSON.stringify(c2),
		);
		check(
			"C2: inherits session thinking level (getThinkingLevel)",
			flagValue(c2, "--thinking") === "medium",
			JSON.stringify(c2),
		);

		// CALL_A: un modelo provider-qualified (tiene "/") NO debe recibir un --provider sintetizado.
		check("A: qualified model does not add --provider", hasFlag(a, "--provider") === false, JSON.stringify(a));

		// CALL_D: un alias pelado de patrón ("sonnet", sin "provider/") debe pinearse al provider
		// de sesión vía --provider, para que pi no lo rutee a un provider SIN autenticar
		// (p. ej. amazon-bedrock -> "No API key found"). El alias en sí se forwardea sin cambios.
		const d = await readArgv("CALL_D");
		check("D: bare alias forwarded as --model", flagValue(d, "--model") === "sonnet", JSON.stringify(d));
		check(
			"D: bare alias pinned to session provider via --provider",
			flagValue(d, "--provider") === "ctx-prov",
			JSON.stringify(d),
		);

		// #3.6 observabilidad de focus: el run completado debe escribir artifacts focus-metrics
		// (el pi fake no emite usage, así que los totales de tokens son 0; verificamos shape + cobertura).
		let metrics = null;
		try {
			metrics = JSON.parse(await fs.readFile(path.join(result.runDir, "metrics.json"), "utf8"));
		} catch {
			metrics = null;
		}
		check("focus: metrics.json artifact written and parses", !!metrics, String(result.runDir));
		check(
			"focus: measuredAgents matches the agents actually run",
			!!metrics && metrics.measuredAgents >= 1,
			metrics && JSON.stringify(metrics.measuredAgents),
		);
		check(
			"focus: has the expected top-level focus keys",
			!!metrics &&
				[
					"inputTokensPeak",
					"outputTokensTotal",
					"toolCalls",
					"toolErrors",
					"toolErrorRate",
					"autoRetries",
					"agents",
				].every((k) => k in metrics),
			metrics && Object.keys(metrics).join(","),
		);
		let metricsMdOk = true;
		try {
			await fs.readFile(path.join(result.runDir, "metrics.md"), "utf8");
		} catch {
			metricsMdOk = false;
		}
		check("focus: metrics.md artifact written", metricsMdOk);

		finish();
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

function finish() {
	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
	process.exit(0);
}

await main();
