#!/usr/bin/env node
/**
 * Test de integración conductual duradero para extensions/pandi-container/index.ts.
 *
 * Apple `container` corre Linux en micro-VMs reales (Apple Silicon + macOS 26 +
 * un subsistema iniciado), que una caja de CI no puede levantar. Entonces la evidencia honesta acá es:
 *   - parsers puros pineados contra salida REAL capturada de la CLI (`container machine ls
 *     --format json`), así el parser se prueba contra el contrato real;
 *   - constructores de argv afirmados exactamente (argv, nunca un string de shell);
 *   - manejadores de alto nivel guiados por un runner simulado INJECTADO, así el despacho,
 *     la barrera de "remove requiere force" y la normalización de errores son deterministas;
 *   - la ruta de CLI ausente ejercitada con un spawn REAL de un binario garantizadamente ausente
 *     (así `spawnError` es real, no mockeado) → mensaje acotado, sin caerse;
 *   - el comando /container y la tool container_sandbox quedan realmente registrados.
 *
 * `container` siempre se invoca con un array ARGV (nunca un string de shell), así
 * referencias de imagen / nombres de máquina / comandos no pueden inyectar shell.
 *
 * Agregados de P4 (issue #3, mutation-verified non-vacuous): ramas de runStatus not-booted /
 * running / degraded-ls, validación de create/stop/exec + normalización de describeError
 * (detalle de stderr, fallback de exit-code, timed-out), parseContainerCommand,
 * timeout + abort REALES de runContainer, y rutas de afuera hacia adentro de comando/tool — cada plataforma
 * pinea su rama real (linux CI: la guarda de plataforma; macOS/arm64: compuertas help/unknown/remove,
 * incluyendo que remove confirmado encadene force:true hasta la CLI, mantenido inocuo vía
 * un nombre de máquina garantizadamente ausente).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBundle() {
	// index.ts usa el SDK solo para tipos (se borran); stubbealo para que esbuild no traiga
	// el runtime real de @earendil-works/pi-coding-agent (cross-spawn rompe un bundle ESM).
	return await buildExtension({
		name: "pi-container-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-container", "index.ts"),
		outName: "container.mjs",
		stubs: { sdk: 'export const CONFIG_DIR_NAME = ".pi";\n' },
		npx: "--no-install",
	});
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	const events = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
			on: (event, handler) => events.set(event, handler),
		},
		commands,
		tools,
		events,
	};
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

/** Un runner simulado con la firma de runContainer; registra llamadas y devuelve resultados prefijados. */
function fakeRunner(scripted = []) {
	const calls = [];
	const opts = [];
	let i = 0;
	const run = async (args, runOpts) => {
		calls.push(args);
		opts.push(runOpts);
		const result = typeof scripted === "function" ? scripted(args, runOpts) : scripted[i++];
		return result ?? { ok: true, stdout: "", stderr: "", exitCode: 0 };
	};
	run.calls = calls;
	run.opts = opts;
	return run;
}

// Salida real capturada de `container machine ls --format json` (1.0.0).
const REAL_MACHINE_JSON =
	'[{"memory":19327352832,"diskSize":78790656,"default":true,"id":"dev","ipAddress":"192.168.64.4","createdDate":"2026-06-30T18:48:46Z","cpus":6,"status":"running"}]';

async function scenarioRegistration(url) {
	const { commands, tools } = await loadExtension(url);
	check("registers /container command", commands.has("container"), [...commands.keys()].join(","));
	check("registers container_sandbox tool", tools.has("container_sandbox"), [...tools.keys()].join(","));
	const tool = tools.get("container_sandbox");
	check("tool has execute()", typeof tool?.execute === "function");
	check("tool is sequential", tool?.executionMode === "sequential", String(tool?.executionMode));
}

async function scenarioPureHelpers(url) {
	const mod = await loadModule(url);

	// guarda de plataforma
	check("isSupportedPlatform(darwin,arm64) true", mod.isSupportedPlatform("darwin", "arm64") === true);
	check("isSupportedPlatform(darwin,x64) false", mod.isSupportedPlatform("darwin", "x64") === false);
	check("isSupportedPlatform(linux,arm64) false", mod.isSupportedPlatform("linux", "arm64") === false);

	// validación de nombre de máquina
	for (const [name, ok] of [
		["dev", true],
		["my-machine_1", true],
		["", false],
		["-x", false],
		["has space", false],
		["a/b", false],
		["a;b", false],
	]) {
		check(`validateMachineName(${JSON.stringify(name)}) === ${ok}`, mod.validateMachineName(name) === ok, name);
	}

	// completions del comando slash: raíz + tiers de create --size
	{
		const root = mod.completeContainerArgs("");
		const rootValues = (root ?? []).map((item) => item.value);
		check(
			"completeContainerArgs: empty prefix lists the core actions",
			["status", "list", "create", "run", "stop", "remove"].every((value) => rootValues.includes(value)),
			JSON.stringify(rootValues),
		);
		const tiers = mod.completeContainerArgs("create --size sm");
		check(
			"completeContainerArgs: create --size filters tiers",
			JSON.stringify(tiers) === JSON.stringify([{ value: "small", label: "small" }]),
			JSON.stringify(tiers),
		);
		check("completeContainerArgs: non-tier second token returns null", mod.completeContainerArgs("run dev") === null);
	}

	// parser pineado a JSON REAL capturado
	const entries = mod.parseMachineList(REAL_MACHINE_JSON);
	check("parseMachineList: one entry", entries.length === 1, String(entries.length));
	const m = entries[0];
	check(
		"parseMachineList: fields",
		m.id === "dev" &&
			m.status === "running" &&
			m.ipAddress === "192.168.64.4" &&
			m.cpus === 6 &&
			m.isDefault === true,
		JSON.stringify(m),
	);
	check("parseMachineList: empty array", mod.parseMachineList("[]").length === 0);
	check("parseMachineList: junk → []", Array.isArray(mod.parseMachineList("not json")));

	// formateador
	const line = mod.formatMachineList(entries);
	check("formatMachineList: mentions id + status", line.includes("dev") && line.includes("running"), line);
	check("formatMachineList: humanizes memory (18G)", /18\s?G/i.test(line), line);
	check(
		"formatMachineList: empty → friendly",
		/no hay máquinas/i.test(mod.formatMachineList([])),
		mod.formatMachineList([]),
	);
}

async function scenarioArgBuilders(url) {
	const mod = await loadModule(url);
	const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

	eq("buildStatusArgs", mod.buildStatusArgs(), ["system", "status", "--format", "json"]);
	eq("buildMachineListArgs", mod.buildMachineListArgs(), ["machine", "ls", "--format", "json"]);

	eq(
		"buildMachineCreateArgs: full (image last)",
		mod.buildMachineCreateArgs({
			name: "dev",
			image: "alpine:latest",
			cpus: 4,
			memory: "8G",
			homeMount: "ro",
			setDefault: true,
		}),
		[
			"machine",
			"create",
			"-n",
			"dev",
			"--set-default",
			"--cpus",
			"4",
			"--memory",
			"8G",
			"--home-mount",
			"ro",
			"alpine:latest",
		],
	);
	eq("buildMachineCreateArgs: minimal", mod.buildMachineCreateArgs({ image: "alpine:latest" }), [
		"machine",
		"create",
		"alpine:latest",
	]);

	eq(
		"buildMachineExecArgs: argv after --",
		mod.buildMachineExecArgs({ name: "dev", workdir: "/work", command: ["echo", "hi there"] }),
		["machine", "run", "-n", "dev", "-w", "/work", "--", "echo", "hi there"],
	);
	eq("buildMachineExecArgs: default machine, no workdir", mod.buildMachineExecArgs({ command: ["uname", "-a"] }), [
		"machine",
		"run",
		"--",
		"uname",
		"-a",
	]);

	eq(
		"buildEphemeralRunArgs: image before args",
		mod.buildEphemeralRunArgs({ image: "alpine:latest", command: ["echo", "x"] }),
		["run", "--rm", "alpine:latest", "echo", "x"],
	);
	eq(
		"buildEphemeralRunArgs: with workdir",
		mod.buildEphemeralRunArgs({ image: "alpine:latest", workdir: "/w", command: ["pwd"] }),
		["run", "--rm", "-w", "/w", "alpine:latest", "pwd"],
	);

	eq("buildStopArgs: named", mod.buildStopArgs({ name: "dev" }), ["machine", "stop", "dev"]);
	eq("buildStopArgs: default", mod.buildStopArgs({}), ["machine", "stop"]);
	eq("buildRemoveArgs", mod.buildRemoveArgs({ name: "dev" }), ["machine", "delete", "dev"]);
}

async function scenarioHandlers(url) {
	const mod = await loadModule(url);

	// list → parsea JSON inyectado a detalles estructurados
	{
		const run = fakeRunner([{ ok: true, stdout: REAL_MACHINE_JSON, stderr: "", exitCode: 0 }]);
		const res = await mod.runList(run, {});
		check("runList: ok", res.ok === true, JSON.stringify(res));
		check("runList: details has machines", res.details?.machines?.length === 1, JSON.stringify(res.details));
		check(
			"runList: called ls --format json",
			JSON.stringify(run.calls[0]) === JSON.stringify(["machine", "ls", "--format", "json"]),
		);
	}

	// exec → arma args y expone stdout
	{
		const run = fakeRunner([{ ok: true, stdout: "Linux 6.18.15\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runExec(run, { machine: "dev", command: ["uname", "-sr"] }, {});
		check("runExec: ok", res.ok === true, JSON.stringify(res));
		check("runExec: text carries stdout", res.text.includes("Linux 6.18.15"), res.text);
		check(
			"runExec: argv via machine run -- ",
			JSON.stringify(run.calls[0]) === JSON.stringify(["machine", "run", "-n", "dev", "--", "uname", "-sr"]),
			JSON.stringify(run.calls[0]),
		);
	}

	// exec efímero (image, sin machine)
	{
		const run = fakeRunner([{ ok: true, stdout: "ok\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runExec(run, { image: "alpine:latest", command: ["echo", "ok"] }, {});
		check("runExec ephemeral: ok", res.ok === true);
		check(
			"runExec ephemeral: run --rm image args",
			JSON.stringify(run.calls[0]) === JSON.stringify(["run", "--rm", "alpine:latest", "echo", "ok"]),
			JSON.stringify(run.calls[0]),
		);
	}

	// exec sin machine ni image → error acotado, sin run
	{
		const run = fakeRunner();
		const res = await mod.runExec(run, { command: ["echo", "x"] }, {});
		check("runExec: requires machine or image", res.ok === false && run.calls.length === 0, JSON.stringify(res));
	}

	// remove sin force → se niega, nunca hace spawn
	{
		const run = fakeRunner();
		const res = await mod.runRemove(run, { name: "dev", force: false }, {});
		check("runRemove: refuses without force", res.ok === false && run.calls.length === 0, JSON.stringify(res));
	}
	// remove con force → elimina
	{
		const run = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res = await mod.runRemove(run, { name: "dev", force: true }, {});
		check(
			"runRemove: force deletes",
			res.ok === true && JSON.stringify(run.calls[0]) === JSON.stringify(["machine", "delete", "dev"]),
			JSON.stringify(res),
		);
	}

	// normalización de errores: spawnError → guía de CLI no encontrada
	{
		const run = fakeRunner([{ ok: false, spawnError: "spawn container ENOENT" }]);
		const res = await mod.runList(run, {});
		check(
			"runList: spawnError → install guidance",
			res.ok === false && /brew install container/i.test(res.text),
			res.text,
		);
	}
}

async function scenarioBareActionSelector(url) {
	const mod = await loadModule(url);
	const makeCtx = ({ hasUI = true, selectResult } = {}) => {
		const selectCalls = [];
		return {
			ctx: {
				hasUI,
				ui: {
					select: async (title, items) => {
						selectCalls.push({ title, items });
						return selectResult;
					},
				},
			},
			selectCalls,
		};
	};

	// sin args + UI → abre el selector de acciones y devuelve el token elegido
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "stop \u2014 stop a machine" });
		const out = await mod.resolveContainerInput("", ctx);
		check("bare + UI opens the action selector once", selectCalls.length === 1, `calls=${selectCalls.length}`);
		const items = selectCalls[0]?.items ?? [];
		const expectedItems = mod.CONTAINER_SELECT_ITEMS ?? [];
		check("selector expected items are exported", expectedItems.length === 6, JSON.stringify(expectedItems));
		check(
			"selector offers exactly the exported action labels",
			JSON.stringify(items) === JSON.stringify(expectedItems),
			JSON.stringify(items),
		);
		check("returns the chosen action token", out === "stop", String(out));
	}

	// sin UI (headless) → nunca abre el selector; pasa la entrada (vacía) sin cambios
	{
		const { ctx, selectCalls } = makeCtx({ hasUI: false, selectResult: "stop" });
		const out = await mod.resolveContainerInput("", ctx);
		check("headless bare never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
		check("headless bare passes through empty input", out === "", JSON.stringify(out));
	}

	// argumento explícito → saltea por completo el selector
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "stop" });
		const out = await mod.resolveContainerInput("list", ctx);
		check("explicit arg bypasses the selector", selectCalls.length === 0 && out === "list", String(out));
	}

	// cancelar el selector → texto vacío (runCommand después muestra ayuda), sin caerse
	{
		const { ctx } = makeCtx({ selectResult: undefined });
		const out = await mod.resolveContainerInput("", ctx);
		check("cancelling the selector yields empty input", out === "", JSON.stringify(out));
	}
}

async function scenarioRealSpawnMissingCli(url) {
	const mod = await loadModule(url);
	// spawn REAL de un binario garantizadamente ausente → spawnError es real, el mensaje es acotado.
	const result = await mod.runContainer(["machine", "ls"], { bin: "container-does-not-exist-xyz", timeoutMs: 5000 });
	check("runContainer: missing bin → ok=false", result.ok === false, JSON.stringify(result));
	check(
		"runContainer: missing bin → spawnError set",
		typeof result.spawnError === "string" && result.spawnError.length > 0,
		JSON.stringify(result),
	);
}

// ramas de runStatus (issue #3 "not booted"): un `system status` fallido debe exponer
// el detalle de la CLI; un subsistema en ejecución lista máquinas; un machine-ls fallido degrada
// a una lista vacía en vez de fallar todo el status.
async function scenarioStatusHandler(url) {
	const mod = await loadModule(url);

	{
		const run = fakeRunner([
			{
				ok: false,
				stdout: "",
				stderr: "apiserver is not running; start with `container system start`",
				exitCode: 1,
			},
		]);
		const res = await mod.runStatus(run, {});
		check("runStatus not booted: ok=false", res.ok === false, JSON.stringify(res));
		check("runStatus not booted: surfaces the CLI detail", /apiserver is not running/.test(res.text), res.text);
		check("runStatus not booted: no machine-ls after the failure", run.calls.length === 1, String(run.calls.length));
	}

	{
		const run = fakeRunner([
			{ ok: true, stdout: "{}", stderr: "", exitCode: 0 },
			{ ok: true, stdout: REAL_MACHINE_JSON, stderr: "", exitCode: 0 },
		]);
		const res = await mod.runStatus(run, {});
		check("runStatus running: ok + machine listed", res.ok === true && /dev/.test(res.text), res.text);
	}

	{
		const run = fakeRunner([
			{ ok: true, stdout: "{}", stderr: "", exitCode: 0 },
			{ ok: false, stdout: "", stderr: "boom", exitCode: 1 },
		]);
		const res = await mod.runStatus(run, {});
		check(
			"runStatus with failing ls: still ok, empty machine list",
			res.ok === true && /No hay máquinas de contenedor/.test(res.text),
			res.text,
		);
	}
}

// bordes de error de create/stop/exec (issue #3 "run failure"): la validación de argumentos se niega
// ANTES de hacer spawn; las fallas de la CLI se normalizan vía describeError (detalle de stderr,
// fallback de exit-code, timed-out).
async function scenarioHandlerErrorEdges(url) {
	const mod = await loadModule(url);

	// create: image faltante / nombre inválido → se niega, sin spawn
	{
		const run = fakeRunner();
		const res = await mod.runCreate(run, { image: "" }, {});
		check("runCreate: missing image refused, no spawn", res.ok === false && run.calls.length === 0, res.text);
		const res2 = await mod.runCreate(run, { image: "alpine:latest", name: "bad name" }, {});
		check("runCreate: invalid name refused, no spawn", res2.ok === false && run.calls.length === 0, res2.text);
	}
	// create: falla de CLI → error normalizado; éxito → texto de confirmación
	{
		const run = fakeRunner([{ ok: false, stdout: "", stderr: "kernel not configured", exitCode: 1 }]);
		const res = await mod.runCreate(run, { image: "alpine:latest", name: "dev" }, {});
		check(
			"runCreate: CLI failure carries stderr detail",
			res.ok === false && /kernel not configured/.test(res.text),
			res.text,
		);
		const run2 = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res2 = await mod.runCreate(run2, { image: "alpine:latest", name: "dev" }, {});
		check(
			"runCreate: success confirms machine + image",
			res2.ok === true && /dev.*alpine:latest/.test(res2.text),
			res2.text,
		);
	}

	// stop: nombre inválido rechazado; falla con salida vacía usa el exit code; nombre default
	{
		const run = fakeRunner();
		const res = await mod.runStop(run, { name: "a;b" }, {});
		check("runStop: invalid name refused, no spawn", res.ok === false && run.calls.length === 0, res.text);
		const run2 = fakeRunner([{ ok: false, stdout: "", stderr: "", exitCode: 7 }]);
		const res2 = await mod.runStop(run2, { name: "dev" }, {});
		check(
			"runStop: empty-detail failure reports the exit code",
			res2.ok === false && /salida 7/.test(res2.text),
			res2.text,
		);
		const run3 = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res3 = await mod.runStop(run3, {}, {});
		check(
			"runStop: no name stops the default machine",
			res3.ok === true && /\(predeterminada\)/.test(res3.text),
			res3.text,
		);
	}

	// exec: nombre de machine inválido rechazado antes del spawn; stdout vacío → marca explícita; timeout → texto timed-out
	{
		const run = fakeRunner();
		const res = await mod.runExec(run, { machine: "a b", command: ["true"] }, {});
		check("runExec: invalid machine name refused, no spawn", res.ok === false && run.calls.length === 0, res.text);
		const run2 = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res2 = await mod.runExec(run2, { machine: "dev", command: ["true"] }, {});
		check(
			"runExec: empty stdout reports '(sin salida)'",
			res2.ok === true && /sin salida/i.test(res2.text),
			res2.text,
		);
		const run3 = fakeRunner([{ ok: false, stdout: "", stderr: "", timedOut: true }]);
		const res3 = await mod.runExec(run3, { machine: "dev", command: ["sleep", "99"] }, {});
		check(
			"runExec: timeout normalizes to 'agotó el tiempo de espera'",
			res3.ok === false && /agotó el tiempo de espera/i.test(res3.text),
			res3.text,
		);
	}
}

// parseContainerCommand (puro): separador argv `--`, valores por defecto e insensibilidad de mayúsculas/minúsculas.
async function scenarioParseContainerCommand(url) {
	const mod = await loadModule(url);
	const p = mod.parseContainerCommand;

	const full = p("run dev -- echo hi there");
	check(
		"parse: '--' splits argv command",
		full.action === "run" && full.rest[0] === "dev" && JSON.stringify(full.command) === '["echo","hi","there"]',
		JSON.stringify(full),
	);
	check("parse: empty input defaults to status", p("").action === "status", JSON.stringify(p("")));
	check("parse: action is lowercased", p("LIST").action === "list", JSON.stringify(p("LIST")));
	check(
		"parse: no '--' means empty command",
		p("stop dev").command.length === 0 && p("stop dev").rest[0] === "dev",
		JSON.stringify(p("stop dev")),
	);
}

// bordes reales de proceso de runContainer: un hijo colgado recibe SIGTERM en timeoutMs (timedOut,
// ok=false), y una señal de abort lo mata igual — spawns reales, no mocks.
async function scenarioConfigurableTimeout(url) {
	const mod = await loadModule(url);

	check("timeout parser: valid env ms accepted", mod.parseTimeoutMs("2500", 120000) === 2500);
	check("timeout parser: invalid env falls back", mod.parseTimeoutMs("nope", 120000) === 120000);
	check("timeout parser: tiny env clamps to 1000", mod.parseTimeoutMs("1", 120000) === 1000);

	const run = fakeRunner([{ ok: true, stdout: REAL_MACHINE_JSON, stderr: "", exitCode: 0 }]);
	await mod.runList(run, { timeoutMs: 4321 });
	check(
		"handler opts: timeoutMs is propagated to runner",
		run.opts[0]?.timeoutMs === 4321,
		JSON.stringify(run.opts[0]),
	);
}

async function scenarioRealTimeoutAndAbort(url) {
	const mod = await loadModule(url);

	const hung = await mod.runContainer(["-e", "setTimeout(() => {}, 10000)"], {
		bin: process.execPath,
		timeoutMs: 300,
	});
	check(
		"runContainer: timeout → ok=false + timedOut",
		hung.ok === false && hung.timedOut === true,
		JSON.stringify(hung),
	);

	const controller = new AbortController();
	const pending = mod.runContainer(["-e", "setTimeout(() => {}, 10000)"], {
		bin: process.execPath,
		signal: controller.signal,
		timeoutMs: 30000,
	});
	setTimeout(() => controller.abort(), 100);
	const aborted = await pending;
	check(
		"runContainer: abort → ok=false + timedOut flag",
		aborted.ok === false && aborted.timedOut === true,
		JSON.stringify(aborted),
	);
}

// De afuera hacia adentro (issue #3): ejercita el handler REAL de /container y la
// tool container_sandbox. El runner no es inyectable a este nivel, así que solo
// se pinean rutas sin spawn — y cada plataforma pinea su rama real: en
// hosts no soportados (linux CI) toda llamada debe cortocircuitar con el mensaje de plataforma;
// en macOS/arm64 corren las rutas help/unknown/remove-gate (ninguna hace spawn).
async function scenarioCommandAndToolOutsideIn(url) {
	const mod = await loadModule(url);
	const { commands, tools } = await loadExtension(url);
	const command = commands.get("container");
	const tool = tools.get("container_sandbox");

	const makeCtx = ({ hasUI = true, confirmResult = false } = {}) => {
		const notes = [];
		const confirms = [];
		const ctx = {
			mode: "tui",
			hasUI,
			cwd: REPO_ROOT,
			ui: {
				notify: (msg, type) => notes.push({ msg, type }),
				confirm: async (title, message) => {
					confirms.push({ title, message });
					return confirmResult;
				},
				select: async () => undefined,
			},
		};
		return { ctx, notes, confirms };
	};

	if (!mod.isSupportedPlatform()) {
		// host no soportado (linux CI): la guarda debe disparar para AMBAS superficies, antes de cualquier spawn.
		const { ctx, notes } = makeCtx();
		await command.handler("status", ctx);
		check(
			"unsupported host: /container reports the platform requirement",
			notes.some((n) => n.type === "error" && /Apple Silicon/i.test(n.msg)),
			JSON.stringify(notes),
		);
		const res = await tool.execute("t1", { action: "status" }, undefined, undefined, ctx);
		check(
			"unsupported host: tool reports the platform requirement",
			res.details?.isError === true && /Apple Silicon/i.test(res.content[0]?.text ?? ""),
			JSON.stringify(res),
		);
		return;
	}

	// host soportado (macOS/arm64): pinear las rutas del comando sin spawn.
	{
		const { ctx, notes } = makeCtx();
		await command.handler("help", ctx);
		check(
			"/container help prints usage",
			notes.some((n) => n.type === "info" && /Uso:/.test(n.msg)),
			JSON.stringify(notes.map((n) => n.type)),
		);
	}
	{
		const { ctx, notes } = makeCtx();
		await command.handler("frobnicate", ctx);
		check(
			"/container unknown subcommand warns + shows usage",
			notes.some(
				(n) => n.type === "warning" && /Subcomando desconocido: frobnicate/.test(n.msg) && /Uso:/.test(n.msg),
			),
			JSON.stringify(notes.map((n) => n.type)),
		);
	}
	{
		// remove vía el comando: rechazar la confirmación debe negarse SIN hacer spawn.
		const { ctx, notes, confirms } = makeCtx({ confirmResult: false });
		await command.handler("remove dev", ctx);
		check("/container remove asks for confirmation", confirms.length === 1, `confirms=${confirms.length}`);
		check(
			"/container remove declined → refuses (needs force)",
			notes.some((n) => n.type === "error" && /Me niego a eliminar/i.test(n.msg)),
			JSON.stringify(notes),
		);
	}
	{
		// remove sin UI (headless): no hay UI para confirmar → force queda false → se niega, sin spawn.
		const { ctx, notes, confirms } = makeCtx({ hasUI: false });
		ctx.mode = "print";
		const errs = [];
		const origErr = console.error;
		console.error = (m) => errs.push(String(m));
		try {
			await command.handler("remove dev", ctx);
		} finally {
			console.error = origErr;
		}
		check("headless remove: never confirms", confirms.length === 0, `confirms=${confirms.length}`);
		check(
			"headless remove: refuses on stderr",
			errs.some((m) => /Me niego a eliminar/i.test(m)),
			JSON.stringify({ errs, notes }),
		);
	}
	{
		// remove CONFIRMADO: el resultado de confirm debe encadenarse como force:true, para que la
		// solicitud llegue a la CLI en vez de la barrera needsForce. Un nombre con forma válida pero
		// garantizadamente ausente mantiene esto inocuo: la CLI falla (machine not
		// found / not installed / not booted) — cualquier cosa MENOS la negativa "Refusing".
		const { ctx, notes, confirms } = makeCtx({ confirmResult: true });
		await command.handler("remove pi-test-absent-machine-xyz", ctx);
		check("/container remove confirmed: confirm was asked", confirms.length === 1, `confirms=${confirms.length}`);
		check(
			"/container remove confirmed: force threads through (no needsForce refusal)",
			notes.length > 0 && !notes.some((n) => /Me niego a eliminar/i.test(n.msg)),
			JSON.stringify(notes),
		);
	}
	{
		// Superficie tool, rutas sin spawn: remove sin force se niega; acción desconocida defensiva.
		const { ctx } = makeCtx();
		const refused = await tool.execute("t2", { action: "remove", name: "dev" }, undefined, undefined, ctx);
		check(
			"tool remove without force refuses (needsForce)",
			refused.details?.isError === true && refused.details?.needsForce === true,
			JSON.stringify(refused.details),
		);
		const bogus = await tool.execute("t3", { action: "bogus" }, undefined, undefined, ctx);
		check(
			"tool unknown action → bounded error result",
			bogus.details?.isError === true && /Acción desconocida/.test(bogus.content[0]?.text ?? ""),
			JSON.stringify(bogus),
		);
	}
}

// Niveles de tamaño (presets con nombre de cpu/memory): la tabla de tiers queda pineada EXACTAMENTE, el puro
// resolver respeta la precedencia de cpus/memory explícitos sobre tier, los argv builders emiten las
// flags resueltas (run efímero gana --cpus/--memory), un tier desconocido se rechaza
// ANTES de cualquier spawn, y los tiers nunca aplican a un run dentro de una máquina existente (sus
// recursos quedan fijados en la creación por la CLI upstream).
async function scenarioSizeTiers(url) {
	const mod = await loadModule(url);
	const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

	// tabla de tiers pineada exactamente (sin snapshots borrosos)
	// Escalera rebasada sobre un micro de 256M (el piso duro de Apple container es 200 MiB; un
	// `npm i -g` + `pi --version` real se verificó dentro de una VM de 200M con 114MB de RSS), duplicando
	// la memoria hacia arriba por tier.
	eq("TIER_PRESETS: pinned values", mod.TIER_PRESETS, {
		micro: { cpus: 1, memory: "256M" },
		tiny: { cpus: 2, memory: "512M" },
		small: { cpus: 2, memory: "1G" },
		medium: { cpus: 4, memory: "2G" },
		large: { cpus: 8, memory: "4G" },
	});
	eq("TIER_NAMES: ordered ladder", mod.TIER_NAMES, ["micro", "tiny", "small", "medium", "large"]);

	// resolver puro: tier solo, explícito-sobre-tier por campo, ninguno, desconocido
	eq("resolveSize: tier only", mod.resolveSize({ tier: "small" }), { ok: true, cpus: 2, memory: "1G" });
	eq("resolveSize: explicit cpus wins over tier", mod.resolveSize({ tier: "small", cpus: 6 }), {
		ok: true,
		cpus: 6,
		memory: "1G",
	});
	eq("resolveSize: explicit memory wins over tier", mod.resolveSize({ tier: "small", memory: "16G" }), {
		ok: true,
		cpus: 2,
		memory: "16G",
	});
	eq("resolveSize: neither tier nor sizes → empty (CLI default)", mod.resolveSize({}), { ok: true });
	{
		const bad = mod.resolveSize({ tier: "xl" });
		check(
			"resolveSize: unknown tier → ok:false listing valid tiers",
			bad.ok === false && /micro/.test(bad.error) && /large/.test(bad.error),
			JSON.stringify(bad),
		);
	}

	// ahora el argv del run efímero lleva las flags resueltas (hoy las descarta en silencio)
	eq(
		"buildEphemeralRunArgs: emits --cpus/--memory before image",
		mod.buildEphemeralRunArgs({ image: "alpine:latest", cpus: 2, memory: "2G", command: ["pwd"] }),
		["run", "--rm", "--cpus", "2", "--memory", "2G", "alpine:latest", "pwd"],
	);

	// create: el tier se resuelve a --cpus/--memory; los valores explícitos pisan; un tier malo nunca hace spawn
	{
		const run = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		const res = await mod.runCreate(run, { image: "alpine:latest", name: "dev", tier: "small" }, {});
		check("runCreate: tier accepted", res.ok === true, JSON.stringify(res));
		eq("runCreate: tier → resolved argv", run.calls[0], [
			"machine",
			"create",
			"-n",
			"dev",
			"--cpus",
			"2",
			"--memory",
			"1G",
			"alpine:latest",
		]);
	}
	{
		const run = fakeRunner([{ ok: true, stdout: "", stderr: "", exitCode: 0 }]);
		await mod.runCreate(run, { image: "alpine:latest", tier: "small", cpus: 6 }, {});
		eq("runCreate: explicit cpus overrides tier in argv", run.calls[0], [
			"machine",
			"create",
			"--cpus",
			"6",
			"--memory",
			"1G",
			"alpine:latest",
		]);
	}
	{
		const run = fakeRunner();
		const res = await mod.runCreate(run, { image: "alpine:latest", tier: "xl" }, {});
		check(
			"runCreate: unknown tier refused, no spawn",
			res.ok === false && run.calls.length === 0 && /small/.test(res.text),
			JSON.stringify(res),
		);
	}

	// `machine create` tiene un piso MÁS DURO que un run efímero: la CLI rechaza memoria de machine
	// por debajo de 1G (error real: "invalid memory value '256mb'. Must be greater
	// than 1gb"), mientras los runs efímeros bajan hasta 200 MiB. Entonces micro/tiny son
	// solo efímeros y create debe rechazarlos ANTES del spawn, con guía.
	eq("MACHINE_TIER_NAMES: machine-capable ladder", mod.MACHINE_TIER_NAMES, ["small", "medium", "large"]);
	for (const tier of ["micro", "tiny"]) {
		const run = fakeRunner();
		const res = await mod.runCreate(run, { image: "alpine:latest", name: "dev", tier }, {});
		check(
			`runCreate: ${tier} refused for machines (1G CLI floor), no spawn`,
			res.ok === false && run.calls.length === 0 && /1G/.test(res.text) && /small/.test(res.text),
			JSON.stringify(res),
		);
	}
	{
		// …pero micro sigue siendo válido para la ruta efímera (ahí el piso es 200 MiB).
		const run = fakeRunner([{ ok: true, stdout: "ok\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runExec(run, { image: "alpine:latest", tier: "micro", command: ["true"] }, {});
		check(
			"runExec ephemeral: micro still allowed (200 MiB floor)",
			res.ok === true && JSON.stringify(run.calls[0]).includes('"256M"'),
			JSON.stringify({ res, argv: run.calls[0] }),
		);
	}

	// run: el tier aplica solo a la ruta efímera; con una machine existente se rechaza
	{
		const run = fakeRunner([{ ok: true, stdout: "ok\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runExec(run, { image: "alpine:latest", tier: "small", command: ["pwd"] }, {});
		check("runExec ephemeral: tier accepted", res.ok === true, JSON.stringify(res));
		eq("runExec ephemeral: tier → resolved argv", run.calls[0], [
			"run",
			"--rm",
			"--cpus",
			"2",
			"--memory",
			"1G",
			"alpine:latest",
			"pwd",
		]);
	}
	{
		const run = fakeRunner();
		const res = await mod.runExec(run, { machine: "dev", tier: "small", command: ["pwd"] }, {});
		check(
			"runExec: tier with existing machine refused, no spawn",
			res.ok === false && run.calls.length === 0 && /fijados en la creación/i.test(res.text),
			JSON.stringify(res),
		);
	}
	{
		const run = fakeRunner();
		const res = await mod.runExec(run, { image: "alpine:latest", tier: "xl", command: ["pwd"] }, {});
		check(
			"runExec ephemeral: unknown tier refused, no spawn",
			res.ok === false && run.calls.length === 0,
			JSON.stringify(res),
		);
	}

	// parseo de flags de /container create (puro): --size extraído de la lista de tokens
	eq("parseSizeFlag: extracts --size", mod.parseSizeFlag(["alpine:latest", "dev", "--size", "small"]), {
		tokens: ["alpine:latest", "dev"],
		tier: "small",
	});
	eq("parseSizeFlag: no flag passes through", mod.parseSizeFlag(["alpine:latest"]), { tokens: ["alpine:latest"] });
	{
		const bad = mod.parseSizeFlag(["alpine:latest", "--size"]);
		check("parseSizeFlag: dangling --size → error", typeof bad.error === "string", JSON.stringify(bad));
	}

	// paridad entre el schema de la tool y la ayuda
	{
		const { commands, tools } = await loadExtension(url);
		const tool = tools.get("container_sandbox");
		const tierSchema = JSON.stringify(tool?.parameters?.properties?.tier ?? "");
		check(
			"tool schema exposes tier enum (micro..large)",
			tierSchema.includes("micro") && tierSchema.includes("large"),
			tierSchema,
		);
		if (mod.isSupportedPlatform()) {
			const notes = [];
			const ctx = {
				mode: "tui",
				hasUI: true,
				cwd: REPO_ROOT,
				ui: { notify: (msg, type) => notes.push({ msg, type }) },
			};
			await commands.get("container").handler("help", ctx);
			check(
				"/container help documents --size tiers",
				notes.some((n) => /--size/.test(n.msg) && /micro/.test(n.msg)),
				JSON.stringify(notes.map((n) => n.msg.slice(0, 80))),
			);
		}
	}
}

async function main() {
	const { url } = await buildBundle();
	await scenarioRegistration(url);
	await scenarioPureHelpers(url);
	await scenarioArgBuilders(url);
	await scenarioHandlers(url);
	await scenarioBareActionSelector(url);
	await scenarioRealSpawnMissingCli(url);
	await scenarioStatusHandler(url);
	await scenarioHandlerErrorEdges(url);
	await scenarioParseContainerCommand(url);
	await scenarioSizeTiers(url);
	await scenarioConfigurableTimeout(url);
	await scenarioRealTimeoutAndAbort(url);
	await scenarioCommandAndToolOutsideIn(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
