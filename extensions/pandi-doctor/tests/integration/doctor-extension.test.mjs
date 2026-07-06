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
	check("registers /doctor command", commands.has("doctor"), [...commands.keys()].join(","));
	check("handler is a function", typeof commands.get("doctor")?.handler === "function");
	check("command has a description", typeof commands.get("doctor")?.description === "string");
}

async function scenarioResolver(url) {
	const mod = await loadModule(url);

	// Desde la raíz del repo, al subir encuentra el `extensions/pandi-doctor/scripts/doctor.mjs` vendorizado.
	const fromRoot = mod.resolveDoctorScript(REPO_ROOT, "/nonexistent/ext");
	check(
		"resolveDoctorScript: finds the vendored script from repo root",
		typeof fromRoot === "string" && fromRoot.endsWith(VENDORED_REL),
		String(fromRoot),
	);

	// Desde un subdir anidado del repo, al subir igual lo encuentra.
	const fromSubdir = mod.resolveDoctorScript(path.join(REPO_ROOT, "extensions", "pandi-doctor"), "/nonexistent/ext");
	check(
		"resolveDoctorScript: finds it from a nested subdir",
		typeof fromSubdir === "string" && fromSubdir.endsWith(VENDORED_REL),
		String(fromSubdir),
	);

	// Respaldo relativo a la extensión: el `cwd` no tiene relación, pero `extDir` trae su propia copia.
	const fromFallback = mod.resolveDoctorScript(path.parse(REPO_ROOT).root, EXT_DIR);
	check(
		"resolveDoctorScript: falls back to the extension's own scripts/doctor.mjs",
		typeof fromFallback === "string" && fromFallback === path.join(EXT_DIR, "scripts", "doctor.mjs"),
		String(fromFallback),
	);

	// Si no resuelve ni `cwd` ni el fallback → `null`.
	const none = mod.resolveDoctorScript(path.parse(REPO_ROOT).root, "/nonexistent/ext");
	check("resolveDoctorScript: null when nothing resolves", none === null, String(none));
}

async function scenarioCheckLogic(url) {
	const mod = await loadModule(url);

	// Ejecución ok → `info`, con el texto del reporte pasado directo.
	{
		const run = fakeRunner([{ ok: true, stdout: "✓ all mandatory present\n", stderr: "", exitCode: 0 }]);
		const res = await mod.runDoctorCheck(run, { cwd: REPO_ROOT, extDir: EXT_DIR });
		check(
			"runDoctorCheck: ok → info + report text",
			res.type === "info" && res.text.includes("all mandatory present") && run.calls.length === 1,
			JSON.stringify(res),
		);
		check(
			"runDoctorCheck: spawns the resolved doctor.mjs",
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
		check("runDoctorCheck: spawns with the session cwd", run.opts[0]?.cwd === nestedCwd, JSON.stringify(run.opts[0]));
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
			"runDoctorCheck: spawnError → error + mentions the failure",
			res.type === "error" && /ENOENT|no se pudo ejecutar/i.test(res.text),
			JSON.stringify(res),
		);
	}

	// Script no encontrado → `warning` que apunta al repo, sin llamar al runner.
	{
		const run = fakeRunner([{ ok: true, stdout: "should not run", stderr: "", exitCode: 0 }]);
		const res = await mod.runDoctorCheck(run, { cwd: path.parse(REPO_ROOT).root, extDir: "/nonexistent/ext" });
		check(
			"runDoctorCheck: script not found → warning, runner not called",
			res.type === "warning" && /pandi-extensions/i.test(res.text) && run.calls.length === 0,
			JSON.stringify(res),
		);
	}
}

async function scenarioRealSpawnMissingBin(url) {
	const mod = await loadModule(url);
	// Spawn REAL de un binario garantizadamente ausente → `spawnError` real, mensaje acotado.
	const script = mod.resolveDoctorScript(REPO_ROOT, EXT_DIR);
	const result = await mod.runDoctor(script, { bin: "node-does-not-exist-xyz", timeoutMs: 5000 });
	check("runDoctor: missing bin → ok=false", result.ok === false, JSON.stringify(result));
	check(
		"runDoctor: missing bin → spawnError set",
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
		check("standalone: exits 0/1 without crashing", r.status === 0 || r.status === 1, `status=${r.status}`);
		check("standalone: prints the doctor report", out.includes("pandi-extensions doctor"), out.slice(0, 200));
		const syncLine = out.split("\n").find((l) => l.includes("sync Claude global")) ?? "";
		check("standalone: sync Claude global is N/A outside the repo", syncLine.includes("N/A"), syncLine);
		const hookLine = out.split("\n").find((l) => l.includes("hook pre-commit")) ?? "";
		check("standalone: hook pre-commit is N/A outside the repo", hookLine.includes("N/A"), hookLine);
		check("standalone: no reference to this repo's path", !out.includes(REPO_ROOT), out.slice(0, 400));
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

function scenarioCanonicalSyncChecks() {
	// Doctor debe delegar a los checks canónicos repo-locales y hacer que cada drift sea accionable:
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
		check("canonical sync: optional drift does not fail mandatory doctor", r.status === 0, out.slice(0, 800));
		for (const [label, fix] of [
			["root manifest", "npm run sync:manifest"],
			["project settings", "npm run sync:settings"],
			["skill mirrors", "npm run sync:skills"],
			["vendor skills", "npm run sync:skills:vendor"],
			["agent guides", "npm run sync:agents"],
			["Claude ultracode skills", "npm run sync:claude:ultracode"],
			["docs HTML mirror", "npm run sync:docs:html"],
			["personas README", "npm run sync:personas"],
		]) {
			const line = out.split("\n").find((l) => l.includes(label)) ?? "";
			check(`canonical sync: ${label} warning names fix command`, /⚠/.test(line) && line.includes(fix), line || out);
		}
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
		const beforeLine = before.split("\n").find((l) => l.includes("hook pre-commit")) ?? "";
		check("hook check: reported when not installed", beforeLine.length > 0, before.slice(0, 400));
		check("hook check: WARN + actionable hint when not installed", /⚠/.test(beforeLine), beforeLine);

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
		const afterLine = after.split("\n").find((l) => l.includes("hook pre-commit")) ?? "";
		check("hook check: OK once hooksPath + hook file are in place", /✓/.test(afterLine), afterLine);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

async function scenarioHandlerEndToEnd(url) {
	const extension = await loadDefault(url);
	const { pi, commands } = makePi();
	extension(pi);
	const notifications = [];
	const ctx = {
		mode: "interactive",
		hasUI: true,
		cwd: REPO_ROOT,
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};
	// Corre el `scripts/doctor.mjs` REAL contra este repo; aserción agnóstica del entorno.
	await commands.get("doctor").handler("", ctx);
	check("handler: notifies exactly once", notifications.length === 1, `count=${notifications.length}`);
	check(
		"handler: notification has non-empty text and a valid type",
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
	await scenarioRealSpawnMissingBin(url);
	scenarioStandaloneDoctor();
	scenarioCanonicalSyncChecks();
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
