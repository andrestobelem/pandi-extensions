#!/usr/bin/env node
/**
 * doctor.mjs — chequeo de entorno read-only para pandi-extensions.
 *
 * Reporta qué prerequisitos (obligatorios y opcionales) están presentes y usables,
 * para que un recién llegado sepa qué le falta antes de `pi install ./`.
 *
 * - No muta nada: solo lee `process.versions`, busca binarios en el PATH con
 *   `<bin> --version` (spawn con argv array, nunca shell) y prueba rutas conocidas.
 * - Sale con código 1 si falta algún requisito OBLIGATORIO; los opcionales solo avisan.
 *
 * Uso:  node extensions/pandi-doctor/scripts/doctor.mjs   (o: npm run doctor)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Subí desde `startDir` para encontrar la raíz de la suite pandi-extensions (el
 * `package.json` del repo). El script ahora vive DENTRO de la extensión pandi-doctor,
 * así que puede correr desde cualquier lugar de instalación; la raíz de la suite es
 * una propiedad del CWD, no de dónde queda el archivo del script.
 */
function findSuiteRoot(startDir) {
	let dir = startDir;
	for (;;) {
		const pkg = path.join(dir, "package.json");
		if (existsSync(pkg)) {
			try {
				if (JSON.parse(readFileSync(pkg, "utf8")).name === "pandi-extensions") return dir;
			} catch {
				// `package.json` ilegible o inválido: seguí subiendo.
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Respaldo relativo al script: `<ext>/scripts` → raíz del repo, pero solo si de verdad ES la suite. */
function suiteRootFromScriptLocation() {
	const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	return findSuiteRoot(candidate) === candidate ? candidate : null;
}

// null ⇒ instalación independiente (p. ej. `npm:@pandi-coding-agent/pandi-doctor`): los
// chequeos solo-del-repo se degradan a N/A en vez de dar warnings falsos.
const SUITE_ROOT = findSuiteRoot(process.cwd()) ?? suiteRootFromScriptLocation();
// Directorio del proyecto para lookups a nivel proyecto (`node_modules`, skills en
// `.agents`/`.pi`, `.pi/settings.json`): la raíz de la suite dentro del repo, o si no el cwd.
const PROJECT_DIR = SUITE_ROOT ?? process.cwd();
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

/** Parsea "v22.19.0" / "codex-cli 0.142.4" -> [22,19,0]; devuelve null si no encuentra ninguna. */
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

/** Corre `<bin> <args>`; devuelve { found, out } sin lanzar (`ENOENT` => `found:false`). */
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
const localMmdc = path.join(PROJECT_DIR, "node_modules", ".bin", process.platform === "win32" ? "mmdc.cmd" : "mmdc");
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
	path.join(PROJECT_DIR, "node_modules", "pi-codex-web-search"),
];
const webSearch = webSearchPaths.some(existsSync);
report(
	"optional",
	webSearch ? OK : WARN,
	"pi-codex-web-search",
	webSearch ? "instalada" : "ausente — pi install npm:pi-codex-web-search",
);

// ctx7 + skill context7-cli. Preferimos el binario local (devDependency, corre con npx).
const localCtx7 = path.join(PROJECT_DIR, "node_modules", ".bin", process.platform === "win32" ? "ctx7.cmd" : "ctx7");
const ctx7 = existsSync(localCtx7) ? probe(localCtx7) : probe("ctx7");
report(
	"optional",
	ctx7.found ? OK : WARN,
	"ctx7 CLI",
	ctx7.found ? "Context7 docs (npx ctx7)" : "ausente — `npm install` (devDep) o npm i -g ctx7@latest",
);
const context7SkillPaths = [
	path.join(PROJECT_DIR, ".agents", "skills", "context7-cli"),
	path.join(PROJECT_DIR, ".pi", "skills", "context7-cli"),
	path.join(os.homedir(), ".pi", "agent", "skills", "context7-cli"),
	path.join(os.homedir(), ".agents", "skills", "context7-cli"),
];
const context7Skill = context7SkillPaths.some(existsSync);
report(
	"optional",
	context7Skill ? OK : WARN,
	"skill context7-cli",
	context7Skill ? "instalado" : "ausente — npx ctx7 setup --cli",
);

// skill karpathy-guidelines: skill EXTERNO (multica-ai/andrej-karpathy-skills). No se vendoriza en
// el repo; el onboarding lo instala global para pi (~/.agents/skills) y Claude Code (~/.claude/skills).
const karpathySkillPaths = [
	path.join(os.homedir(), ".agents", "skills", "karpathy-guidelines"),
	path.join(os.homedir(), ".pi", "agent", "skills", "karpathy-guidelines"),
	path.join(os.homedir(), ".claude", "skills", "karpathy-guidelines"),
];
const karpathySkill = karpathySkillPaths.some(existsSync);
report(
	"optional",
	karpathySkill ? OK : WARN,
	"skill karpathy-guidelines",
	karpathySkill
		? "instalado (global, externo)"
		: "ausente — instalalo global desde multica-ai/andrej-karpathy-skills (ver Quickstart)",
);

// Apple container: solo relevante en macOS Apple Silicon.
if (process.platform === "darwin" && process.arch === "arm64") {
	const container = probe("container");
	report(
		"optional",
		container.found ? OK : WARN,
		"Apple container",
		container.found ? "sandboxes Linux (pandi-container)" : "ausente — brew install container",
	);
} else {
	report("optional", dim("·"), "Apple container", "N/A (solo macOS Apple Silicon)");
}

// sync Claude global: ¿el home global de Claude (default ~/.claude) es un espejo al día del repo?
// Delegamos en el propio script (fuente de verdad del "qué es drift") vía --check; hereda
// CLAUDE_GLOBAL_DIR, así que doctor y sync miran exactamente el mismo destino. Opcional a
// propósito: en un clon fresco sin sync previo esto avisa, no rompe el doctor.
const home = os.homedir();
const globalDir = process.env.CLAUDE_GLOBAL_DIR || path.join(home, ".claude");
// Sólo colapsá a "~" en el borde de segmento, no por prefijo textual (/Users/foo vs /Users/foobar).
const shortDir = globalDir === home || globalDir.startsWith(home + path.sep) ? globalDir.replace(home, "~") : globalDir;
const syncScript = SUITE_ROOT ? path.join(SUITE_ROOT, "scripts", "sync-claude-global.mjs") : null;
const syncLabel = `sync Claude global (${shortDir})`;
if (!SUITE_ROOT) {
	// Instalación independiente: el espejo es una preocupación de desarrollo del repo de
	// la suite, no de esta máquina — N/A, no un warning falso de "out of sync".
	report("optional", dim("·"), "sync Claude global", "N/A (fuera del repo pandi-extensions)");
} else if (existsSync(syncScript)) {
	const sync = spawnSync(process.execPath, [syncScript, "--check"], { encoding: "utf8", timeout: 20000 });
	if (sync.error || typeof sync.status !== "number") {
		// El check no pudo correr (spawn falló / timeout): no afirmes "drift", decí que no se verificó.
		report("optional", WARN, syncLabel, "no se pudo verificar — corré `npm run sync:claude:global:check`");
	} else if (sync.status === 0) {
		report("optional", OK, syncLabel, "espejo al día del repo");
	} else {
		// --check imprime "N file(s) out of sync" en stderr; mostrá el conteo para que sea accionable.
		const m = `${sync.stderr || ""}${sync.stdout || ""}`.match(/(\d+) file\(s\) out of sync/);
		const n = m ? Number(m[1]) : 0;
		const count = n > 0 ? ` (${n} archivo${n === 1 ? "" : "s"})` : "";
		report("optional", WARN, syncLabel, `desincronizado${count} — corré \`npm run sync:claude:global\``);
	}
} else {
	report("optional", WARN, "sync Claude global", "ausente — scripts/sync-claude-global.mjs no encontrado");
}

function checkRepoSync({ label, script, checkCommand, fixCommand, okDetail }) {
	if (!SUITE_ROOT) {
		report("optional", dim("·"), label, "N/A (fuera del repo pandi-extensions)");
		return;
	}
	const scriptPath = path.join(SUITE_ROOT, script);
	if (!existsSync(scriptPath)) {
		report("optional", WARN, label, `ausente — ${script} no encontrado`);
		return;
	}
	const check = spawnSync(process.execPath, [scriptPath, "--check"], {
		cwd: SUITE_ROOT,
		encoding: "utf8",
		timeout: 20000,
	});
	if (check.error || typeof check.status !== "number") {
		report("optional", WARN, label, `no se pudo verificar — corré \`${checkCommand}\``);
	} else if (check.status === 0) {
		report("optional", OK, label, okDetail);
	} else {
		report("optional", WARN, label, `desincronizado — corré \`${fixCommand}\``);
	}
}

// Sync canónico repo-local: cada línea delega al script dueño del dominio vía --check.
// Doctor permanece read-only: diagnostica drift y nombra el comando idempotente que lo arregla.
checkRepoSync({
	label: "root manifest",
	script: path.join("scripts", "sync-root-manifest.mjs"),
	checkCommand: "npm run sync:manifest:check",
	fixCommand: "npm run sync:manifest",
	okDetail: "package.json#pi al día desde subpackages",
});
checkRepoSync({
	label: "project settings",
	script: path.join("scripts", "sync-project-settings.mjs"),
	checkCommand: "npm run sync:settings:check",
	fixCommand: "npm run sync:settings",
	okDetail: ".pi/settings*.json al día desde subpackages",
});
checkRepoSync({
	label: "skill mirrors",
	script: path.join("scripts", "sync-skill-mirrors.mjs"),
	checkCommand: "npm run sync:skills:check",
	fixCommand: "npm run sync:skills",
	okDetail: "mirrors .claude al día de .pi/skills",
});
checkRepoSync({
	label: "vendor skills (extensión)",
	script: path.join("scripts", "vendor-extension-skills.mjs"),
	checkCommand: "npm run sync:skills:vendor:check",
	fixCommand: "npm run sync:skills:vendor",
	okDetail: "espejo al día de .pi/skills",
});
checkRepoSync({
	label: "agent guides",
	script: path.join("scripts", "sync-agent-guides.mjs"),
	checkCommand: "npm run sync:agents:check",
	fixCommand: "npm run sync:agents",
	okDetail: "CLAUDE.md al día de AGENTS.md",
});
checkRepoSync({
	label: "Claude ultracode skills",
	script: path.join("scripts", "generate-claude-ultracode-skills.mjs"),
	checkCommand: "npm run sync:claude:ultracode:check",
	fixCommand: "npm run sync:claude:ultracode",
	okDetail: "skills Claude generados al día de .pi/skills/ultracode",
});
checkRepoSync({
	label: "docs HTML mirror",
	script: path.join("scripts", "sync-docs-html.mjs"),
	checkCommand: "npm run sync:docs:html:check",
	fixCommand: "npm run sync:docs:html",
	okDetail: "docs/html al día de Markdown",
});
checkRepoSync({
	label: "personas README",
	script: path.join("scripts", "sync-personas-readme.mjs"),
	checkCommand: "npm run sync:personas:check",
	fixCommand: "npm run sync:personas",
	okDetail: ".pi/personas/README al día de personas JSON",
});

// hook pre-commit: ¿core.hooksPath apunta al dir versionado scripts/git-hooks y el hook existe?
// Es la verificación rápida local (typecheck + biome + markdownlint) que evita commits rotos en main.
// Opcional a propósito: avisa, no rompe el doctor. Standalone (fuera del repo) no aplica.
const hookLabel = "hook pre-commit (git)";
if (!SUITE_ROOT) {
	report("optional", dim("·"), hookLabel, "N/A (fuera del repo pandi-extensions)");
} else {
	const hooksPathCfg = spawnSync("git", ["config", "core.hooksPath"], {
		cwd: SUITE_ROOT,
		encoding: "utf8",
		timeout: 8000,
	});
	const configured = `${hooksPathCfg.stdout || ""}`.trim();
	const hookFile = path.join(SUITE_ROOT, "scripts", "git-hooks", "pre-commit");
	const installed = configured === "scripts/git-hooks" && existsSync(hookFile);
	report(
		"optional",
		installed ? OK : WARN,
		hookLabel,
		installed
			? "gate rápido activo (typecheck + biome + markdownlint)"
			: "no instalado — corré `npm install` (prepare) o `git config core.hooksPath scripts/git-hooks`",
	);
}

// Doble copia: el dev setup carga la suite desde el WORKING TREE (paths locales en settings
// de proyecto y/o global). Una SEGUNDA copia bajo otra identidad de pi (clon git: o paquete
// npm:@pandi-coding-agent/…) NO se dedup-lica (la identidad difiere) → cada extensión/comando/
// tema cargaría dos veces. Avisamos ANTES de que muerda. Seam de test: PI_DOCTOR_AGENT_DIR.
const agentDir = process.env.PI_DOCTOR_AGENT_DIR || path.join(home, ".pi", "agent");
const readPackageSources = (file) => {
	try {
		const settings = JSON.parse(readFileSync(file, "utf8"));
		return (Array.isArray(settings.packages) ? settings.packages : [])
			.map((p) => (typeof p === "string" ? p : p?.source))
			.filter((s) => typeof s === "string");
	} catch {
		return [];
	}
};
const packageEntries = [
	...readPackageSources(path.join(agentDir, "settings.json")).map((src) => ({ src, base: agentDir })),
	...readPackageSources(path.join(PROJECT_DIR, ".pi", "settings.json")).map((src) => ({
		src,
		base: path.join(PROJECT_DIR, ".pi"),
	})),
];
const isRemote = (src) => /^(git:|npm:|https?:\/\/|ssh:\/\/)/.test(src);
const foreignCopies = packageEntries.filter(
	({ src }) =>
		isRemote(src) &&
		(src.includes("pandi-extensions") ||
			src.includes("pi-dynamic-workflows") ||
			src.includes("pandi-dynamic-workflows") ||
			src.includes("@pandi-coding-agent/")),
);
const workingTreeEntries = packageEntries.filter(({ src, base }) => {
	// Sin un working tree de la suite no hay nada contra lo que hacer carga doble.
	if (!SUITE_ROOT || isRemote(src)) return false;
	const resolved = path.resolve(base, src);
	return resolved === SUITE_ROOT || resolved.startsWith(SUITE_ROOT + path.sep);
});
if (foreignCopies.length && workingTreeEntries.length) {
	const sources = foreignCopies.map((e) => e.src).join(", ");
	report(
		"optional",
		WARN,
		"instalación sin doble copia",
		`conviven el working tree y otra copia de la suite (${sources}) — desinstalá una o desactivá sus recursos con \`pi config\``,
	);
} else {
	report(
		"optional",
		OK,
		"instalación sin doble copia",
		foreignCopies.length ? "copia remota sin working tree en settings" : "la suite se carga de una sola identidad",
	);
}

// ── Salida ──────────────────────────────────────────────────────────────────
console.log(bold("\npandi-extensions doctor\n"));
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
