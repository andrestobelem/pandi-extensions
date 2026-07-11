/**
 * Regresión: output/schema/metrics de agente deben parsearse desde el artifact stdout live
 * COMPLETO en disco, no desde el buffer acotado en memoria.
 *
 * Hallazgo (run 2026-07-03T01-36-13 revisar-dw-farley): cuando la línea FINAL
 * JSON-mode de un subagente (el replay agent_end de todos los mensajes) supera
 * MAX_JOURNALED_STREAM (200 KB) y termina con "\n", el tail-trim en memoria de
 * runStreamingAgentProcess ({preserveLineBoundary:true}) encuentra ese newline terminal
 * como el "first newline of the tail" y corta después de él, dejando
 * result.stdout VACÍO mientras la conversación completa de 16 MB queda en el
 * .stdout.log en disco. Aguas abajo, la extracción de schema veía "empty output",
 * quemaba 3 retries de schema por agente (~20 min de trabajo reviewer cada uno), el script reintentaba
 * agentes completos, pasaba maxAgents=64 y el run fallaba. Las focus metrics
 * (parseadas desde el mismo buffer) reportaban "0 turns, 0 tok" para un agente de 74 turns.
 *
 * Esto maneja un agent() real a través del Worker con un binario `pi` fake
 * (PI_DYNAMIC_WORKFLOWS_PI_COMMAND) que emite un stream realista: un message_end pequeño
 * (assistant text + usage) seguido de UNA línea agent_end gigante
 * (>200 KB, trailing "\n") que lleva el assistant text final: un objeto JSON válido
 * cuyo campo `tail` va último. Con el fix, los datos schema del agente parsean
 * (data.tail === "END") y las focus metrics cuentan el turn message_end; antes del fix,
 * el run falla con "empty output" y metrics reporta 0 turns.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/stdout-disk-source-of-truth.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { check, counts } = createChecker();

// Workflow que le pide a un agente un valor JSON con schema y devuelve sus datos parseados.
const WORKFLOW = [
	"export const meta = { name: 'stdout-disk', description: 'disk is source of truth', phases: [{ title: 'P' }] };",
	"phase('P');",
	"const schema = { type: 'object', required: ['tail'], properties: { tail: { type: 'string' } } };",
	"const data = await agent('emit giant final line', { schema, schemaRetries: 0, cache: false });",
	"return { data };",
].join("\n");

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dw-stdout-disk" });
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-stdout-disk-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "stdout-disk.js"), `${WORKFLOW}\n`, "utf8");

	// Binario `pi` fake que emite un stream JSON-mode realista:
	//  1. un message_end PEQUEÑO con assistant text + usage (el turn de focus-metrics),
	//  2. UNA línea agent_end GIGANTE (>200_000 chars, trailing "\n") cuyos mensajes
	//     llevan el assistant text final: un objeto JSON válido con `tail` AL FINAL para que
	//     cualquier truncamiento lo pierda (y rompa el JSON parse).
	const midEvent = JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "working on it" }],
			usage: {
				input: 2,
				output: 54,
				cacheRead: 0,
				cacheWrite: 7414,
				totalTokens: 7470,
				cost: { input: 0.00002, output: 0.0027, cacheRead: 0, cacheWrite: 0.092675, total: 0.095395 },
			},
		},
	});
	const payload = JSON.stringify({ filler: "x".repeat(250_000), tail: "END" });
	const endEvent = JSON.stringify({
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: "emit giant final line" }] },
			{ role: "assistant", content: [{ type: "text", text: payload }] },
		],
	});
	const stream = `${midEvent}\n${endEvent}\n`;
	const fakePi = path.join(project, "fake-pi.mjs");
	await fs.writeFile(fakePi, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stream)});\n`, {
		mode: 0o755,
	});
	return { project, fakePi };
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(url);
	const ext = mod.default;
	const { project, fakePi } = await makeProject();
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);

	// PI_DYNAMIC_WORKFLOWS_PI_COMMAND se pasa verbatim a spawn() como comando, así que
	// debe ser un único ejecutable. Usá un wrapper shell script que exec node + fake-pi.
	const wrapper = path.join(project, "pi-wrapper.sh");
	await fs.writeFile(
		wrapper,
		`#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePi)} "$@"\n`,
		{ mode: 0o755 },
	);
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = wrapper;

	// Antes del fix el run FALLA (schema ve "empty output") y execute hace throw;
	// atrapalo para que los checks reporten evidencia en vez de crashear la suite.
	let result;
	let executeError;
	try {
		const res = await tool.execute(
			"tc-stdout-disk",
			{ action: "run", name: "stdout-disk", input: {}, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		result = res?.details?.result;
	} catch (err) {
		executeError = err instanceof Error ? err.message : String(err);
	}
	const data = result?.output?.data;

	check("run succeeds despite >200KB final agent_end line", result?.ok === true, executeError ?? result?.error);
	check(
		"schema validated against the COMPLETE on-disk stream (data.tail === 'END')",
		data != null && data.tail === "END",
		JSON.stringify({ data: data == null ? data : { tail: data.tail, fillerLen: (data.filler || "").length } }),
	);

	// Las focus metrics también deben foldarse desde el stream completo: el
	// message_end pequeño (con usage) precede la línea gigante, así que turns/output tokens
	// solo son visibles cuando el parseo va más allá del tail en memoria.
	let agentMetrics;
	try {
		const runsDir = path.join(project, ".pi", "workflows", "runs");
		const runs = await fs.readdir(runsDir);
		const metrics = JSON.parse(await fs.readFile(path.join(runsDir, runs[0], "metrics.json"), "utf8"));
		agentMetrics = metrics?.agents?.[0];
	} catch {
		// dejá agentMetrics undefined; los checks de abajo fallan con evidencia
	}
	check(
		"focus metrics count the message_end turn (turns === 1)",
		agentMetrics?.turns === 1,
		JSON.stringify(agentMetrics ?? null),
	);
	check(
		"focus metrics sum output tokens from the full stream (out === 54)",
		agentMetrics?.outputTokensTotal === 54,
		JSON.stringify(agentMetrics ?? null),
	);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
