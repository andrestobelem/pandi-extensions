#!/usr/bin/env node
/**
 * Test de integración de comportamiento durable para extensions/pandi-typescript-lsp/index.ts.
 *
 * Honesto + hermético (sin red):
 * - Prueba los helpers puros (parseTscDiagnostics / isTsFile / findNearestTsconfig /
 *   filterToTouched / formatDiagnostics / shouldRun / diagnosticsKey) directo contra
 *   los exports del mismo bundle.
 * - Corre una verificación de punta a punta REAL: un proyecto temporal (tsconfig.json + un .ts con
 *   un error de tipos), manejado mediante el tracker tool_result + el borde agent_end
 *   de la extensión, con el tsc REAL de este repo (PI_TS_LSP_TSC → node_modules/typescript/lib/tsc.js).
 *   Reporta el error; una vez que se arregla el archivo, el siguiente borde queda limpio.
 * - Verifica: tool + command registrados; el tracker registra solo archivos .ts tocados;
 *   agent_end NO corre sin TS tocado / en una corrida abortada; feedback advisory
 *   predeterminado (sendMessage nextTurn) con dedupe; autofix optativo (followUp + triggerTurn)
 *   respetando el presupuesto por prompt.
 * - Agregados P4 (issue #4, verificados por mutación y no vacuos): orden de resolución
 *   de resolveTscCommand (env/local/npx), mecánicas REALES de runTsc (timeout,
 *   exit-0-after-timeout sigue sin ser ok, abort, spawnError, salida acotada por
 *   bytes), paths sin engine (sin tsconfig; tsc ausente vía sabotaje de PATH) con
 *   advertencia una sola vez por sesión, scope de proyecto de la herramienta + agrupación
 *   multi-tsconfig, y bordes de ramas del comando /tsc.
 * - #10: una corrida de tsc TIMED-OUT se muestra como inconclusa en toda superficie
 *   (tool isError+timedOut, advertencia de /tsc run, advertencia del borde advisory),
 *   nunca como "clean", y preserva la clave advisory de dedupe (no se verificó nada).
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const REAL_TSC = path.join(REPO_ROOT, "node_modules", "typescript", "lib", "tsc.js");

const { check, counts } = createChecker();

async function buildBundle() {
	// Reemplazo del SDK (pi-coding-agent) igual que hace pandi-worktree: index.ts lo usa
	// solo para TYPES (se borran), pero su ejecución real arrastra el require dinámico
	// de cross-spawn, que rompe un paquete ESM. pi-ai + typebox bundlean desde node_modules.
	return await buildExtension({
		name: "pandi-typescript-lsp-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-typescript-lsp", "index.ts"),
		outName: "typescript-lsp.mjs",
		stubs: { sdk: 'export const CONFIG_DIR_NAME = ".pi";\n' },
		npx: "--no-install",
	});
}

// --- dobles (calco de makePi/makeCtx de pandi-worktree, más captura de eventos y mensajes) ---

function makePi() {
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const messages = [];
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
			on: (event, handler) => handlers.set(event, handler),
			sendMessage: (message, options) => messages.push({ message, options }),
		},
		commands,
		tools,
		handlers,
		messages,
	};
}

function makeCtx({ cwd, mode = "tui", idle = true, pending = false, signal } = {}) {
	const notes = [];
	const ctx = {
		mode,
		hasUI: mode !== "print",
		cwd,
		signal,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: { notify: (msg, type) => notes.push({ msg, type }) },
	};
	ctx._notes = notes;
	return ctx;
}

function lastNote(ctx) {
	return ctx._notes.at(-1) ?? { msg: "", type: undefined };
}

// Cargá una instancia fresca de la extensión. `env` sobreescribe configuración de
// INIT-TIME (se leen una vez en el export default, por ejemplo PI_TS_LSP_MODE /
// PI_TS_LSP_AUTOFIX); se restauran después de la inicialización. PI_TS_LSP_TSC es estado de
// ejecución (se lee en cada spawn de tsc) y se define una sola vez, de forma
// persistente, en main(); nunca acá.
async function loadExtension(url, env = {}) {
	const extension = await loadDefault(url);
	const saved = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		const harness = makePi();
		extension(harness.pi);
		return harness;
	} finally {
		for (const [k] of Object.entries(env)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

async function makeProject({ content }) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tslsp-proj-"));
	await fs.writeFile(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
		"utf8",
	);
	const file = path.join(dir, "sample.ts");
	await fs.writeFile(file, content, "utf8");
	return { dir, file };
}

const BAD_TS = "export const x: string = 123;\n";
const BAD_TS_2 = "export const y: number = true;\n";
const GOOD_TS = 'export const x: string = "ok";\n';

function touch(handlers, ctx, filePath, { toolName = "write", isError = false } = {}) {
	handlers.get("tool_result")({ toolName, isError, input: { path: filePath } }, ctx);
}

async function fireAgentEnd(handlers, ctx) {
	await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);
}

// --- bloques unitarios: helpers puros probados contra las exportaciones del paquete ------

async function scenarioPureHelpers(url) {
	const mod = await loadModule(url);

	// isTsFile
	for (const [p, want] of [
		["a.ts", true],
		["a.tsx", true],
		["a.mts", true],
		["a.cts", true],
		["a.d.ts", false],
		["a.js", false],
		["", false],
		["dir/b.TS", true],
	]) {
		check(`isTsFile(${JSON.stringify(p)}) === ${want}`, mod.isTsFile(p) === want, p);
	}

	// parseTscDiagnostics: dos diagnósticos, CRLF, una línea de continuación
	// indentada y una línea de resumen no indentada que debe ignorarse.
	const out = [
		"src/a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.\r",
		"src/b.ts(10,3): error TS2554: Expected 1 arguments, but got 0.",
		"    An argument for 'x' was not provided.",
		"Found 2 errors in 2 files.",
	].join("\n");
	const diags = mod.parseTscDiagnostics(out);
	check("parseTscDiagnostics: two diagnostics", diags.length === 2, String(diags.length));
	check(
		"parseTscDiagnostics: fields parsed",
		diags[0].file === "src/a.ts" &&
			diags[0].line === 1 &&
			diags[0].col === 7 &&
			diags[0].code === "TS2322" &&
			diags[0].severity === "error",
		JSON.stringify(diags[0]),
	);
	check(
		"parseTscDiagnostics: CRLF stripped from message",
		!/\r/.test(diags[0].message),
		JSON.stringify(diags[0].message),
	);
	check(
		"parseTscDiagnostics: indented continuation folded in",
		/An argument for 'x'/.test(diags[1].message),
		JSON.stringify(diags[1].message),
	);
	check("parseTscDiagnostics: empty input → []", mod.parseTscDiagnostics("").length === 0);

	// formatDiagnostics: top-N + "(+N más)"
	const many = Array.from({ length: 25 }, (_, i) => ({
		file: `f${i}.ts`,
		line: i + 1,
		col: 1,
		code: "TS1",
		severity: "error",
		message: "boom",
	}));
	const fmt = mod.formatDiagnostics(many, { maxErrors: 20 });
	check("formatDiagnostics: hasErrors", fmt.hasErrors === true);
	check(
		"formatDiagnostics: shows exactly maxErrors lines + overflow note",
		fmt.text.split("\n").length === 21 && /\(\+5 más\)/.test(fmt.text),
		`${fmt.text.split("\n").length} | ${fmt.text.split("\n").at(-1)}`,
	);
	const clean = mod.formatDiagnostics([], {});
	check("formatDiagnostics: empty → no errors, empty text", !clean.hasErrors && clean.text === "");

	// shouldRun: tabla de verdad completa alrededor del gate.
	check(
		"shouldRun: runs when touched + idle + !aborted + !pending",
		mod.shouldRun({ touched: 1, aborted: false, idle: true, pending: false }) === true,
	);
	check(
		"shouldRun: no touched → false",
		mod.shouldRun({ touched: 0, aborted: false, idle: true, pending: false }) === false,
	);
	check(
		"shouldRun: aborted → false",
		mod.shouldRun({ touched: 1, aborted: true, idle: true, pending: false }) === false,
	);
	check(
		"shouldRun: not idle → false",
		mod.shouldRun({ touched: 1, aborted: false, idle: false, pending: false }) === false,
	);
	check(
		"shouldRun: pending → false",
		mod.shouldRun({ touched: 1, aborted: false, idle: true, pending: true }) === false,
	);

	// diagnosticsKey: estable e independiente del orden, y distinto para diagnósticos distintos.
	const d1 = [
		{ file: "/x/a.ts", line: 1, col: 1, code: "TS1", severity: "error", message: "a" },
		{ file: "/x/b.ts", line: 2, col: 2, code: "TS2", severity: "error", message: "b" },
	];
	const d2 = [d1[1], d1[0]];
	check("diagnosticsKey: order-independent", mod.diagnosticsKey(d1) === mod.diagnosticsKey(d2));
	const d3 = [{ file: "/x/a.ts", line: 9, col: 1, code: "TS1", severity: "error", message: "a" }];
	check("diagnosticsKey: distinct diagnostics differ", mod.diagnosticsKey(d1) !== mod.diagnosticsKey(d3));
}

async function scenarioFindNearestTsconfig(url) {
	const mod = await loadModule(url);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tslsp-find-"));
	const sub = path.join(root, "a", "b");
	await fs.mkdir(sub, { recursive: true });
	const tsconfig = path.join(root, "tsconfig.json");
	await fs.writeFile(tsconfig, "{}", "utf8");
	const found = mod.findNearestTsconfig(path.join(sub, "deep.ts"), root);
	check("findNearestTsconfig: walks up to root tsconfig", found === tsconfig, found);

	const noConfig = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tslsp-none-"));
	const fb = mod.findNearestTsconfig(path.join(noConfig, "x.ts"), noConfig);
	check("findNearestTsconfig: fallback <cwd>/tsconfig.json", fb === path.join(noConfig, "tsconfig.json"), fb);
	await fs.rm(root, { recursive: true, force: true });
	await fs.rm(noConfig, { recursive: true, force: true });
}

async function scenarioFilterToTouched(url) {
	const mod = await loadModule(url);
	const diags = [
		{ file: "/repo/a.ts", line: 1, col: 1, code: "TS1", severity: "error", message: "m" },
		{ file: "/repo/a.ts", line: 1, col: 1, code: "TS1", severity: "error", message: "m" }, // dup
		{ file: "/repo/other.ts", line: 2, col: 1, code: "TS2", severity: "error", message: "n" },
	];
	const filtered = mod.filterToTouched(diags, ["/repo/a.ts"]);
	check("filterToTouched: keeps only touched files", filtered.length === 1, String(filtered.length));
	check("filterToTouched: dedupes identical diagnostics", filtered[0].file === path.resolve("/repo/a.ts"));
	check("filterToTouched: drops untouched file", !filtered.some((d) => d.file.endsWith("other.ts")));
}

// --- bloques de comportamiento ---------------------------------------------

async function scenarioRegisters(url) {
	const { commands, tools } = await loadExtension(url);
	check("/tsc command registered", commands.has("tsc"));
	check("/tsc has description", /typescript/i.test(commands.get("tsc")?.description || ""));
	check("typescript_diagnostics tool registered", tools.has("typescript_diagnostics"));
	const tool = tools.get("typescript_diagnostics");
	check("tool is sequential", tool?.executionMode === "sequential");
	check(
		"tool has prompt guidelines naming the tool",
		Array.isArray(tool?.promptGuidelines) && tool.promptGuidelines.some((g) => /typescript_diagnostics/.test(g)),
	);
	check("tool has promptSnippet", typeof tool?.promptSnippet === "string" && tool.promptSnippet.length > 0);
	// completions de subcomandos de /tsc
	const gac = commands.get("tsc").getArgumentCompletions;
	const sc = gac("sc");
	check("completions: 'sc' → scope", Array.isArray(sc) && sc.length === 1 && sc[0].value === "scope");
	check("completions: second token → null", gac("scope ") === null);
}

async function scenarioTrackerOnlyTs(url) {
	const { handlers, tools } = await loadExtension(url);
	const { dir } = await makeProject({ content: GOOD_TS });
	const ctx = makeCtx({ cwd: dir });

	// Una escritura no-.ts NO debe trackearse → el chequeo scope=touched a demanda no ve nada.
	touch(handlers, ctx, path.join(dir, "note.md"));
	touch(handlers, ctx, path.join(dir, "script.js"));
	let res = await tools.get("typescript_diagnostics").execute("id", { scope: "touched" }, undefined, undefined, ctx);
	check(
		"tracker: ignores non-.ts writes",
		res.details?.count === 0 && /No se tocó ningún archivo TypeScript/.test(res.content?.[0]?.text || ""),
		JSON.stringify(res.details),
	);

	// Un tool_result con error tampoco debe trackearse.
	touch(handlers, ctx, path.join(dir, "sample.ts"), { isError: true });
	res = await tools.get("typescript_diagnostics").execute("id", { scope: "touched" }, undefined, undefined, ctx);
	check("tracker: ignores errored results", res.details?.count === 0, JSON.stringify(res.details));

	// Una escritura .ts real SÍ se trackea → el chequeo a demanda efectivamente corre tsc (acá limpio).
	touch(handlers, ctx, path.join(dir, "sample.ts"));
	res = await tools.get("typescript_diagnostics").execute("id", { scope: "touched" }, undefined, undefined, ctx);
	check(
		"tracker: records .ts and runs a clean check",
		res.details?.hasErrors === false && /limpio/i.test(res.content?.[0]?.text || ""),
		JSON.stringify(res.details),
	);
	await fs.rm(dir, { recursive: true, force: true });
}

async function scenarioAdvisoryE2E(url) {
	const { handlers, messages } = await loadExtension(url);
	const { dir, file } = await makeProject({ content: BAD_TS });
	const ctx = makeCtx({ cwd: dir });

	// Tocá el archivo malo y después dispará el borde coherente → aviso advisory.
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("advisory e2e: one message sent", messages.length === 1, String(messages.length));
	const sent = messages[0];
	check("advisory e2e: customType is pandi-typescript-lsp", sent?.message?.customType === "pandi-typescript-lsp");
	check("advisory e2e: deliverAs nextTurn", sent?.options?.deliverAs === "nextTurn");
	check("advisory e2e: not a triggerTurn", !sent?.options?.triggerTurn);
	check("advisory e2e: display true", sent?.message?.display === true);
	check(
		"advisory e2e: reports the real TS error",
		/TS2322/.test(sent?.message?.content || ""),
		sent?.message?.content,
	);
	check(
		"advisory e2e: details carry diagnostics",
		sent?.message?.details?.count === 1 && Array.isArray(sent?.message?.details?.diagnostics),
		JSON.stringify(sent?.message?.details),
	);

	// Los mismos errores otra vez → dedupe: sin mensaje nuevo.
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("advisory e2e: identical report is de-duplicated", messages.length === 1, String(messages.length));

	// Arreglá el archivo → el siguiente borde queda limpio, igual sin mensaje nuevo.
	await fs.writeFile(file, GOOD_TS, "utf8");
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("advisory e2e: clean after fix → no new message", messages.length === 1, String(messages.length));
	await fs.rm(dir, { recursive: true, force: true });
}

async function scenarioGateNoRun(url) {
	const { handlers, messages } = await loadExtension(url);
	const { dir, file } = await makeProject({ content: BAD_TS });

	// Sin TS tocado → agent_end es un no-op.
	const idleCtx = makeCtx({ cwd: dir });
	await fireAgentEnd(handlers, idleCtx);
	check("gate: no touched TS → no message", messages.length === 0, String(messages.length));

	// Tocado, pero la corrida fue abortada → sin mensaje.
	const ac = new AbortController();
	ac.abort();
	const abortedCtx = makeCtx({ cwd: dir, signal: ac.signal });
	touch(handlers, abortedCtx, file);
	await fireAgentEnd(handlers, abortedCtx);
	check("gate: aborted run → no message", messages.length === 0, String(messages.length));
	await fs.rm(dir, { recursive: true, force: true });
}

async function scenarioAutofixBudget(url) {
	const { handlers, messages } = await loadExtension(url, {
		PI_TS_LSP_MODE: "autofix",
		PI_TS_LSP_AUTOFIX: "on",
	});
	const { dir, file } = await makeProject({ content: BAD_TS });
	const ctx = makeCtx({ cwd: dir });

	// Empezá un prompt (resetea el presupuesto), tocá el archivo malo y dispará el borde.
	handlers.get("agent_start")({ type: "agent_start" }, ctx);
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("autofix: one follow-up sent", messages.length === 1, String(messages.length));
	check("autofix: deliverAs followUp", messages[0]?.options?.deliverAs === "followUp");
	check("autofix: triggerTurn true", messages[0]?.options?.triggerTurn === true);

	// El follow-up disparado por la propia extensión también emite agent_start; NO debe rearmar
	// el presupuesto, porque sigue siendo el mismo ciclo de autofix.
	handlers.get("agent_start")({ type: "agent_start" }, ctx);
	await fs.writeFile(file, BAD_TS_2, "utf8");
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check(
		"autofix: own follow-up agent_start does not re-arm the budget",
		messages.length === 1,
		String(messages.length),
	);

	// Un prompt nuevo resetea el presupuesto → vuelve a permitirse un seguimiento fresco.
	handlers.get("agent_start")({ type: "agent_start" }, ctx);
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("autofix: new prompt re-arms the budget", messages.length === 2, String(messages.length));
	await fs.rm(dir, { recursive: true, force: true });
}

async function scenarioCommandRun(url) {
	const { commands, handlers, messages } = await loadExtension(url);
	const { dir, file } = await makeProject({ content: BAD_TS });
	const ctx = makeCtx({ cwd: dir });

	// status
	await commands.get("tsc").handler("status", ctx);
	check("cmd status: reports state", /Diagnósticos de TypeScript: on/.test(lastNote(ctx).msg), lastNote(ctx).msg);

	// max <n> rechaza basura y acepta un entero positivo.
	await commands.get("tsc").handler("max zero", ctx);
	check("cmd max: rejects non-int", /Uso: \/tsc max/.test(lastNote(ctx).msg), lastNote(ctx).msg);
	await commands.get("tsc").handler("max 5", ctx);
	check("cmd max: accepts positive int", /max errors: 5/.test(lastNote(ctx).msg), lastNote(ctx).msg);

	// una corrida con scope=project reporta el error directo vía notify (superficie humana).
	await commands.get("tsc").handler("scope project", ctx);
	await commands.get("tsc").handler("run", ctx);
	check(
		"cmd run (project): reports the real error",
		/TS2322/.test(lastNote(ctx).msg) && lastNote(ctx).type === "warning",
		lastNote(ctx).msg,
	);

	// off → el borde coherente pasa a ser un no-op incluso con un archivo malo tocado.
	await commands.get("tsc").handler("off", ctx);
	check("cmd off: disabled state acknowledged", /deshabilitados/.test(lastNote(ctx).msg), lastNote(ctx).msg);
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("cmd off: agent_end is a no-op when disabled", messages.length === 0, String(messages.length));
	await fs.rm(dir, { recursive: true, force: true });
}

// Orden de resolución de resolveTscCommand (issue #4): prioridad de env → tsc local
// más cercano en node_modules → respaldo con npx.
async function scenarioResolveTscCommand(url) {
	const mod = await loadModule(url);

	const viaEnv = mod.resolveTscCommand("/anywhere", { PI_TS_LSP_TSC: "/custom/tsc.js" });
	check(
		"resolve: env override wins (kind env, run with node)",
		viaEnv.kind === "env" && viaEnv.command === process.execPath && viaEnv.args[0] === "/custom/tsc.js",
		JSON.stringify(viaEnv),
	);

	const viaLocal = mod.resolveTscCommand(REPO_ROOT, {});
	check(
		"resolve: nearest node_modules tsc (kind local)",
		viaLocal.kind === "local" && viaLocal.args[0]?.includes(path.join("node_modules", "typescript")),
		JSON.stringify(viaLocal),
	);

	const bare = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tslsp-npx-"));
	try {
		const viaNpx = mod.resolveTscCommand(bare, {});
		check(
			"resolve: no env, no local → npx fallback without package install",
			viaNpx.kind === "npx" &&
				viaNpx.command === "npx" &&
				JSON.stringify(viaNpx.args) === JSON.stringify(["--no-install", "tsc"]),
			JSON.stringify(viaNpx),
		);
	} finally {
		await fs.rm(bare, { recursive: true, force: true });
	}
}

// Mecánicas de runTsc (issue #4 "timeouts"), contra spawns REALES: un tsc colgado
// recibe SIGTERM en timeoutMs (timedOut, ok=false), una señal abortada resuelve sin
// crashear, un binario faltante reporta spawnError y la salida queda acotada por bytes.
// NOTE: cómo aparece aguas arriba una corrida con timeout (hoy: parsed-empty → "clean")
// se trackea aparte como bug de comportamiento; estos pins cubren el contrato del ejecutor.
async function scenarioRunTscMechanics(url) {
	const mod = await loadModule(url);
	check("runTsc is exported for the suite", typeof mod.runTsc === "function", typeof mod.runTsc);
	if (typeof mod.runTsc !== "function") return;

	const hung = await mod.runTsc(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
		cwd: os.tmpdir(),
		timeoutMs: 300,
	});
	check(
		"runTsc: timeout → ok=false + timedOut=true",
		hung.ok === false && hung.timedOut === true,
		JSON.stringify(hung),
	);

	// Un child que IGNORA SIGTERM y después sale 0 DESPUÉS de que dispara el timeout:
	// el exit code solo dice éxito, pero una corrida con timeout NUNCA debe contar como ok;
	// esta es la mitad `!timedOut` de la derivación de ok (exit-0-after-timeout).
	const lateOk = await mod.runTsc(
		process.execPath,
		["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 600)'],
		{ cwd: os.tmpdir(), timeoutMs: 200 },
	);
	check(
		"runTsc: exit 0 AFTER timeout still ok=false (timedOut wins)",
		lateOk.ok === false && lateOk.timedOut === true && lateOk.exitCode === 0,
		JSON.stringify(lateOk),
	);

	const controller = new AbortController();
	const pending = mod.runTsc(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
		cwd: os.tmpdir(),
		signal: controller.signal,
		timeoutMs: 30000,
	});
	setTimeout(() => controller.abort(), 100);
	const aborted = await pending;
	check(
		"runTsc: abort → resolves ok=false, SIGTERM",
		aborted.ok === false && aborted.signal === "SIGTERM",
		JSON.stringify(aborted),
	);

	const missing = await mod.runTsc("tsc-does-not-exist-xyz", ["--version"], { cwd: os.tmpdir(), timeoutMs: 5000 });
	check(
		"runTsc: missing binary → spawnError set",
		missing.ok === false && typeof missing.spawnError === "string" && missing.spawnError.length > 0,
		JSON.stringify(missing),
	);

	const noisy = await mod.runTsc(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(3_000_000, 97))"], {
		cwd: os.tmpdir(),
		timeoutMs: 30000,
	});
	check(
		"runTsc: stdout is byte-bounded (runaway output cannot flood memory)",
		noisy.stdout.length <= 2_000_000,
		`len=${noisy.stdout.length}`,
	);
}

// Ramas sin motor (issue #4 "tsc absent" / "project without tsconfig").
async function scenarioNoEngine(url) {
	// A) Proyecto sin tsconfig: el borde coherente advierte UNA VEZ por sesión y la
	// la herramienta devuelve un resultado isError acotado para ambos scopes.
	const { handlers, tools, messages } = await loadExtension(url);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tslsp-nocfg-"));
	const file = path.join(dir, "sample.ts");
	await fs.writeFile(file, BAD_TS, "utf8");
	const ctx = makeCtx({ cwd: dir });

	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("no tsconfig: no feedback message", messages.length === 0, String(messages.length));
	check(
		"no tsconfig: advisory warning surfaced",
		ctx._notes.some((n) => n.type === "warning" && /no se encontró tsconfig\.json ni tsc/i.test(n.msg)),
		JSON.stringify(ctx._notes),
	);
	const warnsBefore = ctx._notes.length;
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check(
		"no tsconfig: warns only ONCE per session",
		ctx._notes.length === warnsBefore,
		`${warnsBefore} -> ${ctx._notes.length}`,
	);

	touch(handlers, ctx, file);
	const resTouched = await tools
		.get("typescript_diagnostics")
		.execute("id", { scope: "touched" }, undefined, undefined, ctx);
	check(
		"no tsconfig: tool touched scope → isError",
		resTouched.details?.isError === true &&
			/No se encontró tsconfig\.json ni tsc/i.test(resTouched.content?.[0]?.text || ""),
		JSON.stringify(resTouched),
	);
	const resProject = await tools
		.get("typescript_diagnostics")
		.execute("id", { scope: "project" }, undefined, undefined, ctx);
	check(
		"no tsconfig: tool project scope → isError",
		resProject.details?.isError === true,
		JSON.stringify(resProject.details),
	);
	await fs.rm(dir, { recursive: true, force: true });

	// B) tsc AUSENTE (tsconfig presente, sin prioridad de env, sin tsc local, npx inalcanzable):
	// falla el spawn → misma superficie sin motor, nunca un crash.
	const { handlers: h2, messages: m2 } = await loadExtension(url);
	const { dir: dir2, file: file2 } = await makeProject({ content: BAD_TS });
	const ctx2 = makeCtx({ cwd: dir2 });
	const savedTsc = process.env.PI_TS_LSP_TSC;
	const savedPath = process.env.PATH;
	delete process.env.PI_TS_LSP_TSC;
	process.env.PATH = "";
	try {
		touch(h2, ctx2, file2);
		await fireAgentEnd(h2, ctx2);
		check("tsc absent: no feedback message", m2.length === 0, String(m2.length));
		check(
			"tsc absent: advisory no-engine warning",
			ctx2._notes.some((n) => n.type === "warning" && /no se encontró tsconfig\.json ni tsc/i.test(n.msg)),
			JSON.stringify(ctx2._notes),
		);
	} finally {
		if (savedTsc === undefined) delete process.env.PI_TS_LSP_TSC;
		else process.env.PI_TS_LSP_TSC = savedTsc;
		process.env.PATH = savedPath;
		await fs.rm(dir2, { recursive: true, force: true });
	}
}

// Scope `project` de la herramienta con errores reales + agrupación multi-tsconfig
// (issue #4 "ramas de scope touched-vs-project").
async function scenarioScopesAndGrouping(url) {
	// la herramienta con scope=project muestra el error del proyecto incluso sin nada tocado.
	const { tools } = await loadExtension(url);
	const { dir } = await makeProject({ content: BAD_TS });
	const ctx = makeCtx({ cwd: dir });
	const res = await tools.get("typescript_diagnostics").execute("id", { scope: "project" }, undefined, undefined, ctx);
	check(
		"tool project scope: reports the real error with nothing touched",
		res.details?.hasErrors === true && /TS2322/.test(res.content?.[0]?.text || ""),
		JSON.stringify(res.details),
	);
	await fs.rm(dir, { recursive: true, force: true });

	// Dos proyectos hermanos (con tsconfig propio), ambos tocados → UN aviso advisory con
	// ambos errores: runTouchedCheck agrupa por tsconfig más cercano y corre tsc por grupo.
	const { handlers, messages } = await loadExtension(url);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tslsp-multi-"));
	const mk = async (name, content) => {
		const d = path.join(root, name);
		await fs.mkdir(d, { recursive: true });
		await fs.writeFile(
			path.join(d, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
			"utf8",
		);
		const f = path.join(d, "sample.ts");
		await fs.writeFile(f, content, "utf8");
		return f;
	};
	const fa = await mk("proj-a", BAD_TS);
	const fb = await mk("proj-b", BAD_TS_2);
	const mctx = makeCtx({ cwd: root });
	touch(handlers, mctx, fa);
	touch(handlers, mctx, fb);
	await fireAgentEnd(handlers, mctx);
	check("grouping: one advisory for both projects", messages.length === 1, String(messages.length));
	const content = messages[0]?.message?.content || "";
	check(
		"grouping: carries both projects' diagnostics (TS2322 + TS2322/TS2322-bool)",
		/proj-a/.test(content) && /proj-b/.test(content),
		content,
	);
	await fs.rm(root, { recursive: true, force: true });
}

// Issue #10: una corrida de tsc TIMED-OUT debe mostrarse como inconclusa, nunca
// como "clean", y no debe perturbar el estado de dedupe. Usa las costuras de ejecución
// PI_TS_LSP_TSC (script colgado) y PI_TS_LSP_TIMEOUT_MS (presupuesto corto),
// ambas leídas en cada spawn.
async function scenarioTimeoutInconclusive(url) {
	const hangDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tslsp-hang-"));
	const hangScript = path.join(hangDir, "hang.js");
	await fs.writeFile(hangScript, "setTimeout(() => {}, 30000);\n", "utf8");

	const { commands, handlers, tools, messages } = await loadExtension(url);
	const { dir, file } = await makeProject({ content: BAD_TS });
	const ctx = makeCtx({ cwd: dir });

	// Paso 1 (tsc real): el aviso advisory muestra el error y arma la clave de dedupe.
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("timeout: baseline advisory sent (dedupe armed)", messages.length === 1, String(messages.length));

	const savedTsc = process.env.PI_TS_LSP_TSC;
	const savedTimeout = process.env.PI_TS_LSP_TIMEOUT_MS;
	process.env.PI_TS_LSP_TSC = hangScript;
	process.env.PI_TS_LSP_TIMEOUT_MS = "300";
	try {
		// herramienta, scope=project: una verificación con timeout da un resultado ERROR, no "clean".
		const res = await tools
			.get("typescript_diagnostics")
			.execute("id", { scope: "project" }, undefined, undefined, ctx);
		const text = res.content?.[0]?.text || "";
		check("timeout: tool never claims clean", !/limpio/i.test(text), text);
		check(
			"timeout: tool → isError + timedOut + inconclusive text",
			res.details?.isError === true && res.details?.timedOut === true && /tiempo de espera/i.test(text),
			JSON.stringify(res),
		);

		// herramienta, scope=touched: misma superficie inconclusa.
		touch(handlers, ctx, file);
		const resTouched = await tools
			.get("typescript_diagnostics")
			.execute("id", { scope: "touched" }, undefined, undefined, ctx);
		check(
			"timeout: touched scope inconclusive too",
			resTouched.details?.timedOut === true && /tiempo de espera/i.test(resTouched.content?.[0]?.text || ""),
			JSON.stringify(resTouched),
		);

		// /tsc run: una advertencia, no un mensaje informativo de "all clean".
		await commands.get("tsc").handler("scope project", ctx);
		await commands.get("tsc").handler("run", ctx);
		check(
			"timeout: /tsc run warns inconclusive",
			lastNote(ctx).type === "warning" && /tiempo de espera/i.test(lastNote(ctx).msg),
			JSON.stringify(lastNote(ctx)),
		);

		// Paso 2 (borde advisory con tsc colgado): sin mensaje, sin advertencia de
		// no una advertencia de no-engine, sino una advertencia de timeout; y la clave de dedupe debe sobrevivir.
		const notesBefore = ctx._notes.length;
		touch(handlers, ctx, file);
		await fireAgentEnd(handlers, ctx);
		check("timeout: advisory edge sends no message", messages.length === 1, String(messages.length));
		const newNotes = ctx._notes.slice(notesBefore);
		check(
			"timeout: advisory edge warns 'timed out' (not no-engine)",
			newNotes.some((n) => n.type === "warning" && /tiempo de espera/i.test(n.msg)) &&
				!newNotes.some((n) => /no se encontró tsconfig/i.test(n.msg)),
			JSON.stringify(newNotes),
		);
	} finally {
		if (savedTsc === undefined) delete process.env.PI_TS_LSP_TSC;
		else process.env.PI_TS_LSP_TSC = savedTsc;
		if (savedTimeout === undefined) delete process.env.PI_TS_LSP_TIMEOUT_MS;
		else process.env.PI_TS_LSP_TIMEOUT_MS = savedTimeout;
	}

	// Paso 3 (tsc real de nuevo, MISMO error): si el timeout hubiera limpiado lastKey,
	// el reporte idéntico se reenviaría; igual debe seguir deduplicado.
	touch(handlers, ctx, file);
	await fireAgentEnd(handlers, ctx);
	check("timeout: dedupe key survives a timed-out run", messages.length === 1, String(messages.length));

	await fs.rm(hangDir, { recursive: true, force: true });
	await fs.rm(dir, { recursive: true, force: true });
}

// Bordes de ramas del comando /tsc: uso/aceptación de scope, uso/aceptación de autofix,
// subcomando desconocido y `run` sin nada tocado (su mensaje distinto).
async function scenarioCommandEdges(url) {
	const { commands } = await loadExtension(url);
	const { dir } = await makeProject({ content: GOOD_TS });
	const ctx = makeCtx({ cwd: dir });
	const cmd = commands.get("tsc");

	await cmd.handler("scope banana", ctx);
	check("cmd scope: rejects junk with usage", /Uso: \/tsc scope/.test(lastNote(ctx).msg), lastNote(ctx).msg);
	await cmd.handler("scope touched", ctx);
	check("cmd scope: accepts touched", /scope: touched/.test(lastNote(ctx).msg), lastNote(ctx).msg);

	await cmd.handler("autofix banana", ctx);
	check("cmd autofix: rejects junk with usage", /Uso: \/tsc autofix/.test(lastNote(ctx).msg), lastNote(ctx).msg);
	await cmd.handler("autofix on", ctx);
	await cmd.handler("status", ctx);
	check(
		"cmd autofix on: status reflects autofix mode",
		/mode: autofix/.test(lastNote(ctx).msg) && /autofix: on/.test(lastNote(ctx).msg),
		lastNote(ctx).msg,
	);

	await cmd.handler("frobnicate", ctx);
	check("cmd unknown: usage warning", /Uso: \/tsc \[status/.test(lastNote(ctx).msg), lastNote(ctx).msg);

	// `run` con scope=touched y nada tocado → su mensaje PROPIO (no el de no-engine).
	await cmd.handler("run", ctx);
	check(
		"cmd run: nothing touched → dedicated message",
		/No se tocó ningún archivo TypeScript en este turno/.test(lastNote(ctx).msg),
		lastNote(ctx).msg,
	);
	await fs.rm(dir, { recursive: true, force: true });
}

async function main() {
	if (!existsSync(REAL_TSC)) {
		console.error(`Missing real tsc for e2e: ${REAL_TSC}`);
		process.exit(2);
	}
	// PI_TS_LSP_TSC es estado de ejecución leído en cada spawn de tsc; definilo una vez para la suite.
	process.env.PI_TS_LSP_TSC = REAL_TSC;
	const { outDir, url } = await buildBundle();
	try {
		await scenarioPureHelpers(url);
		await scenarioFindNearestTsconfig(url);
		await scenarioFilterToTouched(url);
		await scenarioRegisters(url);
		await scenarioTrackerOnlyTs(url);
		await scenarioAdvisoryE2E(url);
		await scenarioGateNoRun(url);
		await scenarioAutofixBudget(url);
		await scenarioCommandRun(url);
		await scenarioResolveTscCommand(url);
		await scenarioRunTscMechanics(url);
		await scenarioNoEngine(url);
		await scenarioScopesAndGrouping(url);
		await scenarioTimeoutInconclusive(url);
		await scenarioCommandEdges(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
