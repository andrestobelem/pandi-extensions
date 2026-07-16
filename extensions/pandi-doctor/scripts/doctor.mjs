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
// Directorio de la suite para lookups de sus dependencias y skills canónicos: la raíz
// dentro del repo, o si no el cwd en una instalación independiente.
const PROJECT_DIR = SUITE_ROOT ?? process.cwd();
const home = os.homedir();
// `/doctor` corre en un proceso hijo: el handler le pasa el perfil y binario efectivos
// del host. Los fallbacks de distro cubren también `npm run doctor`; sin overrides se
// conserva el comportamiento de pi vanilla.
const agentDir =
	process.env.PI_DOCTOR_AGENT_DIR ||
	process.env.PI_CANTE_CODING_AGENT_DIR ||
	process.env.PANDI_CODING_AGENT_DIR ||
	process.env.PI_CODING_AGENT_DIR ||
	path.join(home, ".pi", "agent");
const projectConfigDir =
	process.env.PI_DOCTOR_CONFIG_DIR ||
	(process.env.PI_CANTE_CODING_AGENT_DIR ? ".picante" : process.env.PANDI_CODING_AGENT_DIR ? ".pandi" : ".pi");
const dynamicPiCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
const piCommand = dynamicPiCommand || process.env.PI_DOCTOR_PI_COMMAND || "pi";
const piCommandArgs = (() => {
	if (dynamicPiCommand || !process.env.PI_DOCTOR_PI_COMMAND_ARGS) return [];
	try {
		const args = JSON.parse(process.env.PI_DOCTOR_PI_COMMAND_ARGS);
		return Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args : [];
	} catch {
		return [];
	}
})();
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

function parseTimeoutMs(raw, fallback) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(1000, Math.floor(n));
}

const PROBE_TIMEOUT_MS = parseTimeoutMs(process.env.PI_DOCTOR_PROBE_TIMEOUT_MS, 8000);
const SYNC_TIMEOUT_MS = parseTimeoutMs(process.env.PI_DOCTOR_SYNC_TIMEOUT_MS, 20000);

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
		const r = spawnSync(bin, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
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

const pi = probe(piCommand, [...piCommandArgs, "--version"]);
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

// Recursos Pi incluidos en el bundle o registrados en el perfil efectivo.
function hasPiPackage(packageName) {
	return [
		path.join(agentDir, "npm", "node_modules", packageName),
		path.join(process.cwd(), projectConfigDir, "npm", "node_modules", packageName),
		path.join(process.cwd(), "node_modules", packageName),
		path.join(PROJECT_DIR, "node_modules", packageName),
	].some(existsSync);
}

const webSearch = hasPiPackage("pi-codex-web-search");
report(
	"optional",
	webSearch ? OK : WARN,
	"pi-codex-web-search",
	webSearch ? "instalada" : "ausente — el bundle completo la instala con `npm install`",
);

const mcpAdapter = hasPiPackage("pi-mcp-adapter");
report(
	"optional",
	mcpAdapter ? OK : WARN,
	"pi-mcp-adapter",
	mcpAdapter ? "instalada" : "ausente — el bundle completo la instala con `npm install`",
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
	path.join(process.cwd(), ".agents", "skills", "context7-cli"),
	path.join(process.cwd(), projectConfigDir, "skills", "context7-cli"),
	path.join(PROJECT_DIR, ".agents", "skills", "context7-cli"),
	path.join(PROJECT_DIR, ".pi", "skills", "context7-cli"),
	path.join(agentDir, "skills", "context7-cli"),
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
	path.join(agentDir, "skills", "karpathy-guidelines"),
	path.join(os.homedir(), ".claude", "skills", "karpathy-guidelines"),
];
const karpathySkill = karpathySkillPaths.some(existsSync);
report(
	"optional",
	karpathySkill ? OK : WARN,
	"skill karpathy-guidelines",
	karpathySkill
		? "instalado (global, externo)"
		: "ausente — instalalo global desde multica-ai/andrej-karpathy-skills (ver Inicio rápido)",
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

// Podman: la extensión pandi-podman es multiplataforma; macOS suele instalarlo con Homebrew.
const podman = probe("podman");
report(
	"optional",
	podman.found ? OK : WARN,
	"Podman",
	podman.found
		? "sandboxes de contenedor restringidos (pandi-podman)"
		: process.platform === "darwin"
			? "ausente — brew install podman"
			: "ausente — instalalo con el gestor de paquetes del sistema",
);

// Sincronización global de Claude: ¿el home global de Claude (default ~/.claude) es un espejo al día del repo?
const globalClaudeDir = process.env.CLAUDE_GLOBAL_DIR || path.join(home, ".claude");
const shortClaudeDir =
	globalClaudeDir === home || globalClaudeDir.startsWith(home + path.sep)
		? globalClaudeDir.replace(home, "~")
		: globalClaudeDir;
const syncClaudeScript = SUITE_ROOT ? path.join(SUITE_ROOT, "scripts", "sync-claude-global.mjs") : null;
const syncClaudeLabel = `sincronización global de Claude (${shortClaudeDir})`;
if (!SUITE_ROOT) {
	report("optional", dim("·"), "sincronización global de Claude", "N/A (fuera del repo pandi-extensions)");
} else if (existsSync(syncClaudeScript)) {
	const sync = spawnSync(process.execPath, [syncClaudeScript, "--check"], {
		encoding: "utf8",
		timeout: SYNC_TIMEOUT_MS,
	});
	if (sync.error || typeof sync.status !== "number") {
		report("optional", WARN, syncClaudeLabel, "no se pudo verificar — corré `npm run sync:claude:global:check`");
	} else if (sync.status === 0) {
		report("optional", OK, syncClaudeLabel, "espejo al día del repo");
	} else {
		const m = `${sync.stderr || ""}${sync.stdout || ""}`.match(/(\d+) file\(s\) out of sync/);
		if (m) {
			const n = Number(m[1]);
			const count = ` (${n} archivo${n === 1 ? "" : "s"})`;
			report(
				"optional",
				WARN,
				syncClaudeLabel,
				`desincronizado${count} — corré \`npm run sync:claude:global:install\``,
			);
		} else {
			report("optional", WARN, syncClaudeLabel, "no se pudo verificar — revisá `npm run sync:claude:global:status`");
		}
	}
} else {
	report(
		"optional",
		WARN,
		"sincronización global de Claude",
		"ausente — scripts/sync-claude-global.mjs no encontrado",
	);
}

// Sincronización global de ~/.agents/skills (Pi, Codex y otros hosts que lean ~/.agents/skills).
const globalAgentsDir = process.env.AGENTS_GLOBAL_DIR || path.join(home, ".agents");
const shortAgentsDir =
	globalAgentsDir === home || globalAgentsDir.startsWith(home + path.sep)
		? globalAgentsDir.replace(home, "~")
		: globalAgentsDir;
const syncAgentsScript = SUITE_ROOT ? path.join(SUITE_ROOT, "scripts", "sync-agents-global.mjs") : null;
const syncAgentsLabel = `sincronización global de ~/.agents/skills (${shortAgentsDir})`;
if (!SUITE_ROOT) {
	report("optional", dim("·"), syncAgentsLabel, "N/A (fuera del repo pandi-extensions)");
} else if (existsSync(syncAgentsScript)) {
	const sync = spawnSync(process.execPath, [syncAgentsScript, "--check"], {
		encoding: "utf8",
		timeout: SYNC_TIMEOUT_MS,
	});
	if (sync.error || typeof sync.status !== "number") {
		report("optional", WARN, syncAgentsLabel, "no se pudo verificar — corré `npm run sync:agents:global:check`");
	} else if (sync.status === 0) {
		report("optional", OK, syncAgentsLabel, "espejo al día del repo");
	} else {
		const m = `${sync.stderr || ""}${sync.stdout || ""}`.match(/(\d+) file\(s\) out of sync/);
		if (m) {
			const n = Number(m[1]);
			const count = ` (${n} archivo${n === 1 ? "" : "s"})`;
			report(
				"optional",
				WARN,
				syncAgentsLabel,
				`desincronizado${count} — corré \`npm run sync:agents:global:install\``,
			);
		} else {
			report("optional", WARN, syncAgentsLabel, "no se pudo verificar — revisá `npm run sync:agents:global:status`");
		}
	}
} else {
	report("optional", WARN, syncAgentsLabel, "ausente — scripts/sync-agents-global.mjs no encontrado");
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
		timeout: SYNC_TIMEOUT_MS,
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
	label: "manifiesto raíz",
	script: path.join("scripts", "sync-root-manifest.mjs"),
	checkCommand: "npm run sync:manifest:check",
	fixCommand: "npm run sync:manifest",
	okDetail: "package.json#pi al día desde subpackages",
});
checkRepoSync({
	label: "configuración del proyecto",
	script: path.join("scripts", "sync-project-settings.mjs"),
	checkCommand: "npm run sync:settings:check",
	fixCommand: "npm run sync:settings",
	okDetail: ".pi/settings*.json al día desde subpackages",
});
checkRepoSync({
	label: "espejos de skills",
	script: path.join("scripts", "sync-skill-mirrors.mjs"),
	checkCommand: "npm run sync:skills:check",
	fixCommand: "npm run sync:skills",
	okDetail: "espejos de .claude al día de .pi/skills",
});
checkRepoSync({
	label: "skills vendorizadas (extensión)",
	script: path.join("scripts", "vendor-extension-skills.mjs"),
	checkCommand: "npm run sync:skills:vendor:check",
	fixCommand: "npm run sync:skills:vendor",
	okDetail: "espejo al día de .pi/skills",
});
checkRepoSync({
	label: "guías de agentes",
	script: path.join("scripts", "sync-agent-guides.mjs"),
	checkCommand: "npm run sync:agents:check",
	fixCommand: "npm run sync:agents",
	okDetail: "CLAUDE.md al día de AGENTS.md",
});
checkRepoSync({
	label: "skills ultracode de Claude",
	script: path.join("scripts", "generate-claude-ultracode-skills.mjs"),
	checkCommand: "npm run sync:claude:ultracode:check",
	fixCommand: "npm run sync:claude:ultracode",
	okDetail: "skills de Claude generados al día de .pi/skills/ultracode",
});
checkRepoSync({
	label: "espejo HTML de docs",
	script: path.join("scripts", "sync-docs-html.mjs"),
	checkCommand: "npm run sync:docs:html:check",
	fixCommand: "npm run sync:docs:html",
	okDetail: "docs/html al día de Markdown",
});
checkRepoSync({
	label: "README de personas",
	script: path.join("scripts", "sync-personas-readme.mjs"),
	checkCommand: "npm run sync:personas:check",
	fixCommand: "npm run sync:personas",
	okDetail: ".pi/personas/README al día de personas JSON",
});
checkRepoSync({
	label: "personas empaquetadas",
	script: path.join("scripts", "sync-personas-package.mjs"),
	checkCommand: "npm run sync:personas:package:check",
	fixCommand: "npm run sync:personas:package",
	okDetail: "pandi-personas al día de .pi/personas",
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
		timeout: PROBE_TIMEOUT_MS,
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
	...readPackageSources(path.join(process.cwd(), projectConfigDir, "settings.json")).map((src) => ({
		src,
		base: path.join(process.cwd(), projectConfigDir),
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
