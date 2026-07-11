/**
 * Comportamiento: el guard de recursión PI_DYNAMIC_WORKFLOWS_DEPTH.
 *
 * La composición ctx.workflow() es depth-1 y un run individual está limitado por maxAgents, pero un
 * subagente spawneado con includeExtensions:true + la tool dynamic_workflow podría, si no,
 * lanzar runs top-level frescos no contados contra el presupuesto padre — nesting ilimitado.
 * El guard propaga un DEPTH por sesión a cada subagente spawneado (depth+1) y RECHAZA
 * start/run/resume cuando una sesión está en el límite (default 2, override PI_DYNAMIC_WORKFLOWS_MAX_DEPTH).
 *
 * Esto fija el lado REFUSE (la garantía de seguridad) + el borde permitido + el override.
 * La propagación a subagentes spawneados es un único pase de env al spawn y no se ejercita
 * acá (requiere un subprocess `pi` real).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		console.log(`FAIL: ${label}${detail ? `  [${String(detail).slice(0, 200)}]` : ""}`);
	}
}

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dwf-recursion-guard", copyScaffolds: true });
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-recursion-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "noop.js"),
		"module.exports = async function workflow(ctx, input) {\n  return { ok: true };\n};\n",
		"utf8",
	);
	return project;
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-depth", params, new AbortController().signal, undefined, ctx);
}

/** Invoca la tool y captura el mensaje de error lanzado (o undefined si no lanzó). */
async function expectThrow(tool, ctx, params) {
	try {
		await runTool(tool, ctx, params);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

const { url } = await buildExtension();
const mod = await import(url);
const ext = mod.default;
const project = await makeProject();
const { pi, tools } = makePi();
(ext.activate ?? ext)(pi, makeCtx(project));
const tool = tools.get("dynamic_workflow");
const ctx = makeCtx(project);

// Baseline limpio de env; restaurar al final.
const savedDepth = process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
const savedMax = process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;
delete process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
delete process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;

try {
	// 1) En el límite default (depth=2), start/run/resume se RECHAZAN con el mensaje del guard.
	process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = "2";
	for (const action of ["start", "run", "resume"]) {
		const msg = await expectThrow(tool, ctx, { action, name: "noop" });
		check(`depth=2: ${action} refused by recursion guard`, !!msg && /recursion guard/i.test(msg), msg);
	}

	// 2) Una acción read-only (scaffold) NUNCA se rechaza, incluso en/sobre el límite.
	{
		const msg = await expectThrow(tool, ctx, { action: "scaffold" });
		check("depth=2: read-only scaffold is NOT refused", msg === undefined, msg);
	}

	// 3) Debajo del límite (depth=1), un run pasa el guard (ejecuta el workflow noop).
	{
		process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = "1";
		const res = await runTool(tool, ctx, { action: "run", name: "noop", timeoutMs: 30_000 });
		check("depth=1: run is allowed (below limit)", res?.details?.result?.ok === true, JSON.stringify(res?.details));
	}

	// 4) Override: PI_DYNAMIC_WORKFLOWS_MAX_DEPTH sube el límite para que depth=2 vuelva a permitirse.
	{
		process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = "2";
		process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH = "5";
		const res = await runTool(tool, ctx, { action: "run", name: "noop", timeoutMs: 30_000 });
		check(
			"depth=2 + max=5: run allowed via override",
			res?.details?.result?.ok === true,
			JSON.stringify(res?.details),
		);
		delete process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;
	}

	// 5) Top-level (depth unset = 0) run no es rechazado por el guard.
	{
		delete process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
		const msg = await expectThrow(tool, ctx, { action: "run", name: "noop", timeoutMs: 30_000 });
		check("depth=0 (top-level): run is allowed", msg === undefined || !/recursion guard/i.test(msg), msg);
	}
} finally {
	if (savedDepth === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
	else process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = savedDepth;
	if (savedMax === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;
	else process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH = savedMax;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
