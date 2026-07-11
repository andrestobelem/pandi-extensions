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
	return await buildExtension({
		name: "pi-doctor-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-doctor", "index.ts"),
		outName: "doctor.mjs",
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
		await mod.runDoctorCheck(run, { cwd: nestedCwd, extDir: EXT_DIR });
		check(
			"runDoctorCheck: hace spawn con el cwd de la sesión",
			run.opts[0]?.cwd === nestedCwd,
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
	const ctx = {
		mode: "interactive",
		hasUI: true,
		cwd: REPO_ROOT,
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};
	const originalCwd = process.cwd();
	try {
		process.chdir(processCwd);
		check("handler: process.cwd difiere de ctx.cwd", process.cwd() !== ctx.cwd);
		// Corre el `scripts/doctor.mjs` REAL contra ctx.cwd, no contra el cwd del proceso host.
		await commands.get("doctor").handler("", ctx);
	} finally {
		process.chdir(originalCwd);
		fs.rmSync(processCwd, { recursive: true, force: true });
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
}

async function main() {
	const { url } = await buildBundle();
	await scenarioRegistration(url);
	await scenarioResolver(url);
	await scenarioCheckLogic(url);
	await scenarioConfigurableTimeout(url);
	await scenarioRealSpawnMissingBin(url);
	scenarioStandaloneDoctor();
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
