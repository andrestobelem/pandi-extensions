#!/usr/bin/env node
/**
 * Test de integración conductual durable para `extensions/pandi-doctor/index.ts`.
 *
 * `/doctor` es una conveniencia liviana dentro de la sesión que hace spawn del
 * chequeo read-only de entorno vendorizado por la extensión
 * (`extensions/pandi-doctor/scripts/doctor.mjs`) y muestra su reporte. Evidencia
 * honesta:
 *   - el comando `/doctor` efectivamente se registra;
 *   - `resolveDoctorScript` sube desde un `cwd` para encontrar la copia del
 *     working tree de `extensions/pandi-doctor/scripts/doctor.mjs`, cae en la copia
 *     vendorizada propia de la extensión (`<extDir>/scripts/doctor.mjs`) y devuelve
 *     null cuando ninguna resuelve;
 *   - `runDoctorCheck` (manejado por un runner falso INJECTADO) mapea
 *     `ok`/`exit`/`spawnError` al texto + `type` correctos para notify, de forma
 *     determinística;
 *   - el camino de binario ausente se ejercita con un spawn REAL de un binario
 *     garantizadamente ausente (así `spawnError` es real, no simulado) → mensaje
 *     acotado, sin crash;
 *   - el command handler corre de punta a punta contra el doctor REAL del repo y llama a
 *     `ctx.ui.notify` una vez con texto no vacío (agnóstico del entorno: `info` o `error`).
 *
 * `doctor.mjs` se ejecuta con un array ARGV (nunca un shell string).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.resolve(__dirname, "..", "..");

const { check, counts } = createChecker();

/** Dónde vive el script doctor vendorizado, relativo a la raíz de la suite/working tree. */
const VENDORED_REL = path.join("extensions", "pandi-doctor", "scripts", "doctor.mjs");

async function buildBundle() {
	// `index.ts` usa el SDK solo por tipos (se borran); stubbealo para que esbuild no
	// traiga el runtime real de `@earendil-works/pi-coding-agent`.
	const extension = await buildExtension({
		name: "pi-doctor-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-doctor", "index.ts"),
		outName: "doctor.mjs",
		stubs: {
			sdk: 'export const CONFIG_DIR_NAME = ".pi";\nexport const getAgentDir = () => process.env.PI_DOCTOR_TEST_AGENT_DIR;\nexport const getPackageDir = () => process.env.PI_DOCTOR_TEST_PACKAGE_DIR;\n',
		},
		npx: "--no-install",
	});
	const helpers = await buildExtension({
		name: "pi-doctor-helpers-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-doctor", "doctor.ts"),
		outName: "doctor-helpers.mjs",
		npx: "--no-install",
	});
	return { url: extension.url, helpersUrl: helpers.url };
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

/** Runner falso que respeta la firma de `runDoctor`; registra llamadas y devuelve resultados prefijados. */
function fakeRunner(scripted = []) {
	const calls = [];
	const opts = [];
	let i = 0;
	const run = async (scriptPath, runOpts) => {
		calls.push(scriptPath);
		opts.push(runOpts);
		const result = typeof scripted === "function" ? scripted(scriptPath) : scripted[i++];
		return result ?? { ok: true, stdout: "", stderr: "", exitCode: 0 };
	};
	run.calls = calls;
	run.opts = opts;
	return run;
}

async function scenarioRegistration(url) {
	const { commands } = await loadExtension(url);
	check("registra el comando /doctor", commands.has("doctor"), [...commands.keys()].join(","));
	check("el handler es una función", typeof commands.get("doctor")?.handler === "function");
	check("el comando tiene una descripción", typeof commands.get("doctor")?.description === "string");
}

async function scenarioResolver(url) {
	const mod = await loadModule(url);

	// Desde la raíz del repo, al subir encuentra el `extensions/pandi-doctor/scripts/doctor.mjs` vendorizado.
	const fromRoot = mod.resolveDoctorScript(REPO_ROOT, "/nonexistent/ext");
	check(
		"resolveDoctorScript: encuentra el script vendorizado desde la raíz del repo",
		typeof fromRoot === "string" && fromRoot.endsWith(VENDORED_REL),
		String(fromRoot),
	);

	// Desde un subdir anidado del repo, al subir igual lo encuentra.
	const fromSubdir = mod.resolveDoctorScript(path.join(REPO_ROOT, "extensions", "pandi-doctor"), "/nonexistent/ext");
	check(
		"resolveDoctorScript: lo encuentra desde un subdirectorio anidado",
		typeof fromSubdir === "string" && fromSubdir.endsWith(VENDORED_REL),
		String(fromSubdir),
	);

	// Respaldo relativo a la extensión: el `cwd` no tiene relación, pero `extDir` trae su propia copia.
	const fromFallback = mod.resolveDoctorScript(path.parse(REPO_ROOT).root, EXT_DIR);
	check(
		"resolveDoctorScript: cae al scripts/doctor.mjs propio de la extensión",
		typeof fromFallback === "string" && fromFallback === path.join(EXT_DIR, "scripts", "doctor.mjs"),
		String(fromFallback),
	);

	// Si no resuelve ni `cwd` ni el fallback → `null`.
	const none = mod.resolveDoctorScript(path.parse(REPO_ROOT).root, "/nonexistent/ext");
	check("resolveDoctorScript: null cuando nada resuelve", none === null, String(none));
}

async function scenarioCheckLogic(url) {
	const mod = await loadModule(url);

	// Ejecución ok → `info`, con el texto del reporte pasado directo.
	{
		const run = fakeRunner([{ ok: true, stdout: "✓ todos los obligatorios presentes\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR });
		check(
			"runDoctorCheck: ok → info + texto del reporte",
			res.type === "info" && res.text.includes("todos los obligatorios presentes") && run.calls.length === 1,
			JSON.stringify(res),
		);
		check(
			"runDoctorCheck: invoca el doctor resuelto",
			String(run.calls[0]).endsWith(VENDORED_REL),
			String(run.calls[0]),
		);
	}

	// El runner recibe el `cwd` de la sesión (`doctor.mjs` descubre la raíz de la
	// suite desde ahí), no el directorio abuelo del script.
	{
		const nestedCwd = path.join(REPO_ROOT, "extensions");
		const run = fakeRunner([{ ok: true, stdout: "ok", stderr: "", exitCode: 0 }]);
		await mod.runDoctorCheck(run, {
			cwd: nestedCwd,
			extDir: EXT_DIR,
			agentDir: "/tmp/picante-agent",
			configDir: ".pi-cante",
			piCommand: "/tmp/picante",
			piCommandArgs: ["/tmp/dist/cli.js"],
		});
		check(
			"runDoctorCheck: hace spawn con el cwd de la sesión",
			run.opts[0]?.cwd === nestedCwd,
			JSON.stringify(run.opts[0]),
		);
		check(
			"runDoctorCheck: propaga perfil y comando efectivos al proceso hijo",
			run.opts[0]?.agentDir === "/tmp/picante-agent" &&
				run.opts[0]?.configDir === ".pi-cante" &&
				run.opts[0]?.piCommand === "/tmp/picante" &&
				run.opts[0]?.piCommandArgs?.[0] === "/tmp/dist/cli.js",
			JSON.stringify(run.opts[0]),
		);
	}

	// `exit 1` (falta un obligatorio) → `error`.
	{
		const run = fakeRunner([{ ok: false, stdout: "✗ Pi CLI missing\n", stderr: "", exitCode: 1 }]);
		const res = await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR });
		check(
			"runDoctorCheck: exit 1 → error",
			res.type === "error" && res.text.includes("Pi CLI missing"),
			JSON.stringify(res),
		);
	}

	// `spawnError` → mensaje de error acotado, sin throw.
	{
		const run = fakeRunner([{ ok: false, spawnError: "spawn node ENOENT" }]);
		const res = await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR });
		check(
			"runDoctorCheck: spawnError → error + menciona la falla",
			res.type === "error" && /ENOENT|no se pudo ejecutar/i.test(res.text),
			JSON.stringify(res),
		);
	}

	// Script no encontrado → `warning` que apunta al repo, sin llamar al runner.
	{
		const run = fakeRunner([{ ok: true, stdout: "should not run", stderr: "", exitCode: 0 }]);
		const res = await mod.runDoctorCheck(run, { cwd: path.parse(REPO_ROOT).root, extDir: "/nonexistent/ext" });
		check(
			"runDoctorCheck: script ausente → warning, runner no llamado",
			res.type === "warning" && /pandi-extensions/i.test(res.text) && run.calls.length === 0,
			JSON.stringify(res),
		);
	}
}

async function scenarioConfigurableTimeout(url) {
	const mod = await loadModule(url);

	check("parser de timeout: acepta ms de entorno válidos", mod.parseTimeoutMs("2500", 120000) === 2500);
	check("parser de timeout: un valor inválido vuelve al fallback", mod.parseTimeoutMs("nope", 120000) === 120000);
	check("parser de timeout: un valor chico se clava en 1000", mod.parseTimeoutMs("1", 120000) === 1000);

	const run = fakeRunner([{ ok: true, stdout: "✓ ok", stderr: "", exitCode: 0 }]);
	await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR, timeoutMs: 4321 });
	check(
		"runDoctorCheck: timeoutMs se propaga al runner",
		run.opts[0]?.timeoutMs === 4321,
		JSON.stringify(run.opts[0]),
	);
}

async function scenarioHostPiCommandResolution(helpersUrl) {
	const mod = await loadModule(helpersUrl);
	const hostPackageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-host-command-"));
	try {
		fs.writeFileSync(
			path.join(hostPackageDir, "package.json"),
			JSON.stringify({
				name: "@pandi-coding-agent/pi-cante",
				bin: { picante: "dist/cli.js" },
				piConfig: { name: "pi-cante" },
			}),
		);

		const posix = mod.resolveHostPiCommand(hostPackageDir, {}, "linux", "/usr/bin/node");
		check(
			"binario host: POSIX conserva el nombre nominal",
			posix?.command === "picante" && Array.isArray(posix.args) && posix.args.length === 0,
			JSON.stringify(posix),
		);

		const windows = mod.resolveHostPiCommand(hostPackageDir, {}, "win32", "C:\\nodejs\\node.exe");
		check(
			"binario host: Windows ejecuta package.json#bin mediante node.exe",
			windows?.command === "C:\\nodejs\\node.exe" &&
				windows.args?.length === 1 &&
				windows.args[0] === path.resolve(hostPackageDir, "dist/cli.js"),
			JSON.stringify(windows),
		);

		const override = mod.resolveHostPiCommand(
			hostPackageDir,
			{ PI_DYNAMIC_WORKFLOWS_PI_COMMAND: "C:\\dev\\pi-wrapper.exe" },
			"win32",
			"C:\\nodejs\\node.exe",
		);
		check(
			"binario host: PI_DYNAMIC_WORKFLOWS_PI_COMMAND conserva precedencia sin prefix args",
			override?.command === "C:\\dev\\pi-wrapper.exe" && override.args?.length === 0,
			JSON.stringify(override),
		);
	} finally {
		fs.rmSync(hostPackageDir, { recursive: true, force: true });
	}
}

async function scenarioRealSpawnMissingBin(url) {
	const mod = await loadModule(url);
	// Spawn REAL de un binario garantizadamente ausente → `spawnError` real, mensaje acotado.
	const script = mod.resolveDoctorScript(REPO_ROOT, EXT_DIR);
	const result = await mod.runDoctor(script, { bin: "node-does-not-exist-xyz", timeoutMs: 5000 });
	check("runDoctor: bin ausente → ok=false", result.ok === false, JSON.stringify(result));
	check(
		"runDoctor: bin ausente → spawnError presente",
		typeof result.spawnError === "string" && result.spawnError.length > 0,
		JSON.stringify(result),
	);
}

function scenarioStandaloneDoctor() {
	// Copiá SOLO el script vendorizado a un dir temporal fuera del repo (como una
	// instalación npm de `@pandi-coding-agent/pandi-doctor`) y corrélo de verdad desde
	// un `cwd` fuera del repo: debe degradarse con gracia, sin asumir que existe el
	// repo de la suite.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-standalone-"));
	try {
		const extDir = path.join(tmp, "ext");
		fs.mkdirSync(path.join(extDir, "scripts"), { recursive: true });
		fs.copyFileSync(path.join(EXT_DIR, "scripts", "doctor.mjs"), path.join(extDir, "scripts", "doctor.mjs"));
		const agentDir = path.join(tmp, "agent"); // punto de inyección vacío: la configuración host no debe filtrarse
		fs.mkdirSync(agentDir, { recursive: true });
		const r = spawnSync(process.execPath, [path.join(extDir, "scripts", "doctor.mjs")], {
			cwd: tmp,
			encoding: "utf8",
			timeout: 60000,
			env: { ...process.env, NO_COLOR: "1", PI_DOCTOR_AGENT_DIR: agentDir },
		});
		const out = `${r.stdout || ""}${r.stderr || ""}`;
		check("independiente: sale 0/1 sin crashear", r.status === 0 || r.status === 1, `status=${r.status}`);
		check("independiente: imprime el reporte del doctor", out.includes("pandi-extensions doctor"), out.slice(0, 200));
		const syncLine = out.split("\n").find((l) => l.includes("sincronización global de Claude")) ?? "";
		check("independiente: sincronización global de Claude es N/A fuera del repo", syncLine.includes("N/A"), syncLine);
		const hookLine = out.split("\n").find((l) => l.includes("hook pre-commit")) ?? "";
		check("independiente: hook pre-commit es N/A fuera del repo", hookLine.includes("N/A"), hookLine);
		check("independiente: no referencia la ruta de este repo", !out.includes(REPO_ROOT), out.slice(0, 400));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function writeFakeSyncScript(file, name) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node\nif (process.argv.includes("--check")) { console.error("[${name}] drift"); process.exit(1); }\n`,
		{ mode: 0o755 },
	);
}

function writeHungSyncScript(file) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n", { mode: 0o755 });
}

function findDoctorLine(output, label) {
	return output.split("\n").find((line) => line.includes(label)) ?? "";
}

function createAgentResources(agentDir) {
	fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "pi-codex-web-search"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "skills", "context7-cli"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "skills", "karpathy-guidelines"), { recursive: true });
}

function scenarioEffectiveAgentDir() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-agent-dir-"));
	try {
		const extDir = path.join(tmp, "ext");
		const script = path.join(extDir, "scripts", "doctor.mjs");
		const home = path.join(tmp, "home");
		const vanillaAgentDir = path.join(home, ".pi", "agent");
		const picanteAgentDir = path.join(tmp, "picante-agent");
		const officialAgentDir = path.join(tmp, "official-agent");
		const pandiAgentDir = path.join(tmp, "pandi-agent");
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.copyFileSync(path.join(EXT_DIR, "scripts", "doctor.mjs"), script);
		createAgentResources(vanillaAgentDir);
		createAgentResources(officialAgentDir);
		createAgentResources(pandiAgentDir);
		fs.writeFileSync(
			path.join(vanillaAgentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@pandi-coding-agent/pandi-goal"] }),
		);

		const run = (overrides, unset = []) => {
			const env = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				NO_COLOR: "1",
				PI_DYNAMIC_WORKFLOWS_PI_COMMAND: process.execPath,
				...overrides,
			};
			for (const name of [
				"PI_DOCTOR_AGENT_DIR",
				"PI_DOCTOR_PI_COMMAND",
				"PI_CANTE_CODING_AGENT_DIR",
				"PANDI_CODING_AGENT_DIR",
				...unset,
			]) {
				if (overrides[name] === undefined) delete env[name];
			}
			return spawnSync(process.execPath, [script], {
				cwd: tmp,
				encoding: "utf8",
				timeout: 60000,
				env,
			});
		};
		const assertResources = (label, result, expected) => {
			const out = `${result.stdout || ""}${result.stderr || ""}`;
			for (const resource of ["pi-codex-web-search", "skill context7-cli", "skill karpathy-guidelines"]) {
				const line = findDoctorLine(out, resource);
				check(`${label}: ${resource} usa el perfil efectivo`, line.includes(expected), line || out.slice(0, 800));
			}
			return out;
		};

		const picante = run({
			PI_CANTE_CODING_AGENT_DIR: picanteAgentDir,
			PI_CODING_AGENT_DIR: officialAgentDir,
			PI_DOCTOR_PI_COMMAND: path.join(tmp, "missing-picante"),
			PI_DOCTOR_PI_COMMAND_ARGS: JSON.stringify([path.join(tmp, "missing-entrypoint.js")]),
		});
		const picanteOut = assertResources("Picante", picante, "⚠");
		check(
			"Picante: el probe usa el comando hijo efectivo",
			findDoctorLine(picanteOut, "Pi CLI").includes(process.versions.node),
			findDoctorLine(picanteOut, "Pi CLI"),
		);
		check(
			"Picante: la detección de doble copia ignora settings de vanilla",
			findDoctorLine(picanteOut, "instalación sin doble copia").includes("una sola identidad"),
			findDoctorLine(picanteOut, "instalación sin doble copia"),
		);

		const official = run({ PI_CODING_AGENT_DIR: officialAgentDir }, [
			"PI_CANTE_CODING_AGENT_DIR",
			"PANDI_CODING_AGENT_DIR",
		]);
		assertResources("override oficial", official, "✓");

		const pandi = run({ PANDI_CODING_AGENT_DIR: pandiAgentDir, PI_CODING_AGENT_DIR: picanteAgentDir }, [
			"PI_CANTE_CODING_AGENT_DIR",
		]);
		assertResources("Pandi", pandi, "✓");

		const vanilla = run({}, ["PI_CANTE_CODING_AGENT_DIR", "PANDI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]);
		assertResources("vanilla", vanilla, "✓");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function scenarioSessionProjectResources() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-session-project-"));
	try {
		const agentDir = path.join(tmp, "agent");
		fs.mkdirSync(path.join(tmp, ".pi-cante", "npm", "node_modules", "pi-codex-web-search"), {
			recursive: true,
		});
		fs.mkdirSync(path.join(tmp, ".pi-cante", "skills", "context7-cli"), { recursive: true });
		const r = spawnSync(process.execPath, [path.join(EXT_DIR, "scripts", "doctor.mjs")], {
			cwd: tmp,
			encoding: "utf8",
			timeout: 60000,
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_DOCTOR_AGENT_DIR: agentDir,
				PI_DOCTOR_CONFIG_DIR: ".pi-cante",
				PI_DYNAMIC_WORKFLOWS_PI_COMMAND: process.execPath,
			},
		});
		const out = `${r.stdout || ""}${r.stderr || ""}`;
		check(
			"proyecto de sesión: detecta web-search desde cwd/<config>/npm/node_modules",
			findDoctorLine(out, "pi-codex-web-search").includes("✓"),
			findDoctorLine(out, "pi-codex-web-search"),
		);
		check(
			"proyecto de sesión: detecta Context7 desde cwd/<config>/skills",
			findDoctorLine(out, "skill context7-cli").includes("✓"),
			findDoctorLine(out, "skill context7-cli"),
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function scenarioCanonicalSyncChecks() {
	// Doctor debe delegar en los checks canónicos repo-locales y hacer que cada drift sea accionable:
	// qué dominio falló y qué comando seguro/idempotente lo arregla. Estos son opcionales: no deben
	// convertir el doctor en error si los prerequisitos obligatorios están presentes.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-sync-"));
	try {
		fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "pandi-extensions" }));
		const extDir = path.join(tmp, "ext");
		fs.mkdirSync(path.join(extDir, "scripts"), { recursive: true });
		fs.copyFileSync(path.join(EXT_DIR, "scripts", "doctor.mjs"), path.join(extDir, "scripts", "doctor.mjs"));
		const agentDir = path.join(tmp, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		writeFakeSyncScript(path.join(tmp, "scripts", "sync-root-manifest.mjs"), "sync-root-manifest");
		writeFakeSyncScript(path.join(tmp, "scripts", "sync-project-settings.mjs"), "sync-project-settings");
		writeFakeSyncScript(path.join(tmp, "scripts", "sync-skill-mirrors.mjs"), "sync-skill-mirrors");
		writeFakeSyncScript(path.join(tmp, "scripts", "vendor-extension-skills.mjs"), "vendor-extension-skills");
		writeFakeSyncScript(path.join(tmp, "scripts", "sync-agent-guides.mjs"), "sync-agent-guides");
		writeFakeSyncScript(
			path.join(tmp, "scripts", "generate-claude-ultracode-skills.mjs"),
			"generate-claude-ultracode-skills",
		);
		writeFakeSyncScript(path.join(tmp, "scripts", "sync-docs-html.mjs"), "sync-docs-html");
		writeFakeSyncScript(path.join(tmp, "scripts", "sync-personas-readme.mjs"), "sync-personas-readme");
		writeFakeSyncScript(path.join(tmp, "scripts", "sync-claude-global.mjs"), "sync-claude-global");

		const r = spawnSync(process.execPath, [path.join(extDir, "scripts", "doctor.mjs")], {
			cwd: tmp,
			encoding: "utf8",
			timeout: 60000,
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_DOCTOR_AGENT_DIR: agentDir,
				PI_DYNAMIC_WORKFLOWS_PI_COMMAND: process.execPath,
			},
		});
		const out = `${r.stdout || ""}${r.stderr || ""}`;
		check(
			"sincronización canónica: el drift opcional no rompe el doctor obligatorio",
			r.status === 0,
			out.slice(0, 800),
		);
		for (const [label, fix] of [
			["manifiesto raíz", "npm run sync:manifest"],
			["configuración del proyecto", "npm run sync:settings"],
			["espejos de skills", "npm run sync:skills"],
			["skills vendorizadas (extensión)", "npm run sync:skills:vendor"],
			["guías de agentes", "npm run sync:agents"],
			["skills ultracode de Claude", "npm run sync:claude:ultracode"],
			["espejo HTML de docs", "npm run sync:docs:html"],
			["README de personas", "npm run sync:personas"],
		]) {
			const line = findDoctorLine(out, label);
			check(
				`sincronización canónica: ${label} avisa el comando de arreglo`,
				/⚠/.test(line) && line.includes(fix),
				line || out,
			);
		}
		const claudeGlobalLine = findDoctorLine(out, "sincronización global de Claude");
		check(
			"sincronización global de Claude: un error sin conteo se reporta como no verificado",
			claudeGlobalLine.includes("no se pudo verificar") && !claudeGlobalLine.includes(":install"),
			claudeGlobalLine || out,
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function scenarioSyncTimeoutOverride() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-sync-timeout-"));
	try {
		fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "pandi-extensions" }));
		const extDir = path.join(tmp, "ext");
		fs.mkdirSync(path.join(extDir, "scripts"), { recursive: true });
		fs.copyFileSync(path.join(EXT_DIR, "scripts", "doctor.mjs"), path.join(extDir, "scripts", "doctor.mjs"));
		const agentDir = path.join(tmp, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		writeHungSyncScript(path.join(tmp, "scripts", "sync-root-manifest.mjs"));

		const started = Date.now();
		const r = spawnSync(process.execPath, [path.join(extDir, "scripts", "doctor.mjs")], {
			cwd: tmp,
			encoding: "utf8",
			timeout: 10000,
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_DOCTOR_AGENT_DIR: agentDir,
				PI_DOCTOR_SYNC_TIMEOUT_MS: "1000",
			},
		});
		const elapsed = Date.now() - started;
		const out = `${r.stdout || ""}${r.stderr || ""}`;
		const line = findDoctorLine(out, "manifiesto raíz");
		check(
			"timeout de sync: el override de entorno mantiene acotado al doctor",
			elapsed < 6000,
			`elapsed=${elapsed}ms`,
		);
		check(
			"timeout de sync: el timeout reporta no verificado, no drift",
			/no se pudo verificar/.test(line),
			line || out,
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function scenarioPreCommitHookCheck() {
	// Dentro de un repo git parecido a la suite, doctor debe reportar si el hook
	// `pre-commit` versionado (`scripts/git-hooks` + `core.hooksPath`) está instalado:
	// `WARN` cuando falta, `OK` una vez que `git config core.hooksPath scripts/git-hooks`
	// apunta a un archivo de hook existente.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hook-"));
	try {
		spawnSync("git", ["init", "-q"], { cwd: tmp, encoding: "utf8", timeout: 10000 });
		fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "pandi-extensions" }));
		const extDir = path.join(tmp, "ext");
		fs.mkdirSync(path.join(extDir, "scripts"), { recursive: true });
		fs.copyFileSync(path.join(EXT_DIR, "scripts", "doctor.mjs"), path.join(extDir, "scripts", "doctor.mjs"));
		const agentDir = path.join(tmp, "agent"); // punto de inyección vacío: la configuración host no debe filtrarse
		fs.mkdirSync(agentDir, { recursive: true });
		const runDoctorHere = () =>
			spawnSync(process.execPath, [path.join(extDir, "scripts", "doctor.mjs")], {
				cwd: tmp,
				encoding: "utf8",
				timeout: 60000,
				env: { ...process.env, NO_COLOR: "1", PI_DOCTOR_AGENT_DIR: agentDir },
			});

		const before = `${runDoctorHere().stdout || ""}`;
		const beforeLine = findDoctorLine(before, "hook pre-commit");
		check("chequeo del hook: se reporta cuando no está instalado", beforeLine.length > 0, before.slice(0, 400));
		check("chequeo del hook: WARN + pista accionable cuando falta", /⚠/.test(beforeLine), beforeLine);

		// Instalación: archivo de hook versionado + `core.hooksPath`, exactamente como hace `npm install` (`prepare`).
		const hooksDir = path.join(tmp, "scripts", "git-hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		spawnSync("git", ["config", "core.hooksPath", "scripts/git-hooks"], {
			cwd: tmp,
			encoding: "utf8",
			timeout: 10000,
		});

		const after = `${runDoctorHere().stdout || ""}`;
		const afterLine = findDoctorLine(after, "hook pre-commit");
		check("chequeo del hook: OK cuando `hooksPath` + archivo de hook están listos", /✓/.test(afterLine), afterLine);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

async function scenarioHandlerEndToEnd(url) {
	const extension = await loadDefault(url);
	const { pi, commands } = makePi();
	extension(pi);
	const notifications = [];
	const processCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-handler-cwd-"));
	const hostPackageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-host-package-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-handler-agent-"));
	fs.writeFileSync(
		path.join(hostPackageDir, "package.json"),
		JSON.stringify({ bin: { [process.execPath]: "dist/cli.js" }, piConfig: { name: "pi-cante" } }),
	);
	const ctx = {
		mode: "interactive",
		hasUI: true,
		cwd: REPO_ROOT,
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};
	const originalCwd = process.cwd();
	const originalPackageDir = process.env.PI_DOCTOR_TEST_PACKAGE_DIR;
	const originalAgentDir = process.env.PI_DOCTOR_TEST_AGENT_DIR;
	const originalPiCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	try {
		process.env.PI_DOCTOR_TEST_PACKAGE_DIR = hostPackageDir;
		process.env.PI_DOCTOR_TEST_AGENT_DIR = agentDir;
		delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		process.chdir(processCwd);
		check("handler: process.cwd difiere de ctx.cwd", process.cwd() !== ctx.cwd);
		// Corre el `scripts/doctor.mjs` REAL contra ctx.cwd, no contra el cwd del proceso host.
		await commands.get("doctor").handler("", ctx);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(processCwd, { recursive: true, force: true });
		fs.rmSync(hostPackageDir, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
		if (originalPackageDir === undefined) delete process.env.PI_DOCTOR_TEST_PACKAGE_DIR;
		else process.env.PI_DOCTOR_TEST_PACKAGE_DIR = originalPackageDir;
		if (originalAgentDir === undefined) delete process.env.PI_DOCTOR_TEST_AGENT_DIR;
		else process.env.PI_DOCTOR_TEST_AGENT_DIR = originalAgentDir;
		if (originalPiCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = originalPiCommand;
	}
	check("handler: notifica exactamente una vez", notifications.length === 1, `count=${notifications.length}`);
	check(
		"handler: resuelve el doctor desde ctx.cwd aunque process.cwd sea distinto",
		notifications[0]?.type !== "warning" &&
			!/No se encontró `scripts\/doctor\.mjs`/.test(notifications[0]?.message ?? ""),
		JSON.stringify(notifications[0]),
	);
	check(
		"handler: la notificación tiene texto no vacío y un tipo válido",
		typeof notifications[0]?.message === "string" &&
			notifications[0].message.trim().length > 0 &&
			["info", "warning", "error"].includes(notifications[0]?.type),
		JSON.stringify(notifications[0]),
	);
	check(
		"handler: el doctor hijo prueba el binario efectivo del host",
		findDoctorLine(notifications[0]?.message ?? "", "Pi CLI").includes(process.versions.node),
		findDoctorLine(notifications[0]?.message ?? "", "Pi CLI"),
	);
}

async function main() {
	const { url, helpersUrl } = await buildBundle();
	await scenarioRegistration(url);
	await scenarioResolver(url);
	await scenarioCheckLogic(url);
	await scenarioConfigurableTimeout(url);
	await scenarioHostPiCommandResolution(helpersUrl);
	await scenarioRealSpawnMissingBin(url);
	scenarioStandaloneDoctor();
	scenarioEffectiveAgentDir();
	scenarioSessionProjectResources();
	scenarioCanonicalSyncChecks();
	scenarioSyncTimeoutOverride();
	scenarioPreCommitHookCheck();
	await scenarioHandlerEndToEnd(url);

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
