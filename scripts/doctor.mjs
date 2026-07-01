#!/usr/bin/env node
/**
 * doctor.mjs — chequeo de entorno read-only para pi-dynamic-workflows.
 *
 * Reporta qué prerequisitos (obligatorios y opcionales) están presentes y usables,
 * para que un recién llegado sepa qué le falta antes de `pi install ./`.
 *
 * - No muta nada: solo lee `process.versions`, busca binarios en el PATH con
 *   `<bin> --version` (spawn con argv array, nunca shell) y prueba rutas conocidas.
 * - Sale con código 1 si falta algún requisito OBLIGATORIO; los opcionales solo avisan.
 *
 * Uso:  node scripts/doctor.mjs   (o: npm run doctor)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE = "22.19.0"; // engines.node de @earendil-works/pi-coding-agent
const GONDOLIN_NODE = "23.6.0"; // piso extra para la extensión opcional Gondolin

const NO_COLOR = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const red = (s) => paint("31", s);
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);

const OK = green("✓");
const WARN = yellow("⚠");
const FAIL = red("✗");

/** Parse "v22.19.0" / "codex-cli 0.142.4" -> [22,19,0]; null if none. */
function parseSemver(text) {
	const m = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function gte(a, b) {
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
		if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
	}
	return true;
}

/** Run `<bin> <args>`; returns { found, out } without throwing (ENOENT => found:false). */
function probe(bin, args = ["--version"]) {
	try {
		const r = spawnSync(bin, args, { encoding: "utf8", timeout: 8000 });
		if (r.error) return { found: false, out: "" };
		const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
		return { found: r.status === 0 || Boolean(out), out };
	} catch {
		return { found: false, out: "" };
	}
}

const results = []; // { level: "required"|"optional", ok: boolean, line: string }
function report(level, symbol, name, detail) {
	results.push({
		level,
		ok: symbol === OK,
		line: `  ${symbol} ${bold(name)}${detail ? ` ${dim(`— ${detail}`)}` : ""}`,
	});
}

// ── Obligatorios ──────────────────────────────────────────────────────────────
const nodeV = parseSemver(process.versions.node);
if (nodeV && gte(nodeV, parseSemver(MIN_NODE))) {
	const gond = gte(nodeV, parseSemver(GONDOLIN_NODE)) ? "" : ` (Gondolin opcional necesita ≥ ${GONDOLIN_NODE})`;
	report("required", OK, `Node.js ${process.versions.node}`, `≥ ${MIN_NODE}${gond}`);
} else {
	report(
		"required",
		FAIL,
		`Node.js ${process.versions.node}`,
		`se requiere ≥ ${MIN_NODE} — instalá con: nvm install 22 && nvm use 22`,
	);
}

const npm = probe(process.platform === "win32" ? "npm.cmd" : "npm");
report(
	"required",
	npm.found ? OK : FAIL,
	"npm",
	npm.found ? npm.out.split("\n")[0] : "no encontrado (viene con Node.js)",
);

const git = probe("git");
report(
	"required",
	git.found ? OK : FAIL,
	"git",
	git.found ? git.out.split("\n")[0] : "no encontrado — brew install git / xcode-select --install",
);

const pi = probe(process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND || "pi");
report(
	"required",
	pi.found ? OK : FAIL,
	"Pi CLI",
	pi.found ? pi.out.split("\n")[0] : "no encontrado — npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
);

// ── Opcionales ──────────────────────────────────────────────────────────────
// mmdc: gráficos PNG de /workflow graph (probamos node_modules local y PATH).
const localMmdc = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "mmdc.cmd" : "mmdc");
const mmdc = existsSync(localMmdc) ? probe(localMmdc) : probe("mmdc");
report(
	"optional",
	mmdc.found ? OK : WARN,
	"mmdc (@mermaid-js/mermaid-cli)",
	mmdc.found ? `gráficos /workflow graph` : "ausente — se instala con `npm install`; fallback a topología ASCII",
);

// codex: web_search para subagentes.
const codex = probe(process.env.CODEX_PATH || "codex");
report(
	"optional",
	codex.found ? OK : WARN,
	"codex CLI",
	codex.found ? `web_search disponible` : "ausente — brew install codex (o npm i -g @openai/codex)",
);

// pi-codex-web-search: la extensión que expone web_search.
const webSearchPaths = [
	path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-codex-web-search"),
	path.join(REPO_ROOT, "node_modules", "pi-codex-web-search"),
];
const webSearch = webSearchPaths.some(existsSync);
report(
	"optional",
	webSearch ? OK : WARN,
	"pi-codex-web-search",
	webSearch ? "instalada" : "ausente — pi install npm:pi-codex-web-search",
);

// ctx7 + skill context7-cli. Preferimos el binario local (devDependency, corre con npx).
const localCtx7 = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "ctx7.cmd" : "ctx7");
const ctx7 = existsSync(localCtx7) ? probe(localCtx7) : probe("ctx7");
report(
	"optional",
	ctx7.found ? OK : WARN,
	"ctx7 CLI",
	ctx7.found ? "Context7 docs (npx ctx7)" : "ausente — `npm install` (devDep) o npm i -g ctx7@latest",
);
const context7SkillPaths = [
	path.join(REPO_ROOT, ".agents", "skills", "context7-cli"),
	path.join(REPO_ROOT, ".pi", "skills", "context7-cli"),
	path.join(os.homedir(), ".pi", "agent", "skills", "context7-cli"),
	path.join(os.homedir(), ".agents", "skills", "context7-cli"),
];
const context7Skill = context7SkillPaths.some(existsSync);
report(
	"optional",
	context7Skill ? OK : WARN,
	"skill context7-cli",
	context7Skill ? "instalado" : "ausente — ctx7 skills install ...",
);

// Apple container: solo relevante en macOS Apple Silicon.
if (process.platform === "darwin" && process.arch === "arm64") {
	const container = probe("container");
	report(
		"optional",
		container.found ? OK : WARN,
		"Apple container",
		container.found ? "sandboxes Linux (pi-container)" : "ausente — brew install container",
	);
} else {
	report("optional", dim("·"), "Apple container", "N/A (solo macOS Apple Silicon)");
}

// ── Salida ──────────────────────────────────────────────────────────────────
console.log(bold("\npi-dynamic-workflows doctor\n"));
console.log(bold("Obligatorios:"));
for (const r of results.filter((r) => r.level === "required")) console.log(r.line);
console.log(bold("\nOpcionales:"));
for (const r of results.filter((r) => r.level === "optional")) console.log(r.line);

const requiredFailed = results.filter((r) => r.level === "required" && !r.ok);
const optionalMissing = results.filter((r) => r.level === "optional" && !r.ok && !r.line.includes("N/A"));
console.log("");
if (requiredFailed.length) {
	console.log(
		red(
			`${FAIL} Faltan ${requiredFailed.length} requisito(s) obligatorio(s). Instalalos y volvé a correr \`npm run doctor\`.`,
		),
	);
	process.exit(1);
}
console.log(green(`${OK} Todos los requisitos obligatorios están presentes.`));
if (optionalMissing.length) {
	console.log(yellow(`${WARN} ${optionalMissing.length} capacidad(es) opcional(es) sin instalar (ver arriba).`));
}
process.exit(0);
