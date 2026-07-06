/**
 * Test durable para scripts/sync-claude-global.mjs: la tool de operador que espeja los assets
 * Claude-facing de este repo en un home global de Claude Code (default ~/.claude).
 *
 * El destino es inyectable (--dest <dir> / CLAUDE_GLOBAL_DIR) precisamente para que este test pueda
 * correr contra un tmp dir descartable y nunca tocar el $HOME real. Fuente de verdad = el repo.
 *
 * Esto pinea:
 *   - Landing: después de un sync, el set gestionado existe en destino: workflows (todos los .js +
 *     README), el script runtime (build-workflow-artifact.mjs), las skills del proyecto y la
 *     referencia de primitives ultracode (sourceada desde .pi canónico).
 *   - --check idempotente: inmediatamente después de un sync, `--check` sale 0 (sin drift).
 *   - Sensibilidad (control negativo): tampear un archivo syncado hace que `--check` salga 1, así el
 *     check no es vacuo.
 *   - Sin prune: un archivo ajeno ya presente en destino (p. ej. una skill global-only) sobrevive un
 *     sync; nunca borramos contenido global no gestionado.
 *
 * Sin build de extensión / sin modelo: test puro de filesystem + proceso de script.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/sync-claude-global.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-claude-global.mjs");

// Skills commiteadas que el sync siempre debe publicar. Las skills EXTERNAS (p. ej. karpathy-guidelines, de
// multica-ai/andrej-karpathy-skills) intencionalmente NO están acá: no están vendoreadas en este repo
// y el onboarding las instala globalmente desde upstream en vez de republicarlas.
const REQUIRED_SKILLS = [
	"ultracode",
	"modern-software-engineering",
	"init-pandi-extensions",
	"ai-assisted-engineering",
];
// Skills local-only (p. ej. open-prose está gitignored intencionalmente): se syncan best-effort cuando existen
// en disco, así que esta aserción debe ser condicional o se pone roja en un clone fresco / CI.
const OPTIONAL_SKILLS = ["open-prose"];

const { check, counts } = createChecker();

function run(dest, extra = []) {
	return spawnSync(process.execPath, [SYNC, "--dest", dest, ...extra], { cwd: REPO_ROOT, encoding: "utf8" });
}

function main() {
	check("sync-claude-global.mjs exists", fs.existsSync(SYNC));
	if (!fs.existsSync(SYNC)) return finish();

	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-"));

	// Fixture no-prune: una skill ajena global-only que debe sobrevivir al sync.
	const foreign = path.join(dest, "skills", "supacode-cli");
	fs.mkdirSync(foreign, { recursive: true });
	fs.writeFileSync(path.join(foreign, "SKILL.md"), "# foreign global-only skill\n");

	// 1) Sync al destino tmp.
	const res = run(dest);
	check(
		"sync exits 0",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" | ")}`,
	);

	// 2) Workflows aterrizaron (todos los .js de .claude/workflows + README).
	const srcWf = path.join(REPO_ROOT, ".claude", "workflows");
	const wantWf = fs.readdirSync(srcWf).filter((f) => f.endsWith(".js")).length;
	const gotWf = fs.existsSync(path.join(dest, "workflows"))
		? fs.readdirSync(path.join(dest, "workflows")).filter((f) => f.endsWith(".js")).length
		: 0;
	check("all workflow .js landed", gotWf === wantWf && wantWf > 0, `want=${wantWf} got=${gotWf}`);
	check("workflows README landed", fs.existsSync(path.join(dest, "workflows", "README.md")));

	// 3) Script runtime aterrizó.
	check(
		"build-workflow-artifact.mjs landed",
		fs.existsSync(path.join(dest, "scripts", "build-workflow-artifact.mjs")),
	);

	// 3b) Su árbol de dependencias lib/ también aterrizó, byte-idéntico; si no, el
	// `import ./lib/artifact.mjs` de la CLI syncada globalmente no puede resolver instalada standalone.
	const srcLib = path.join(REPO_ROOT, ".claude", "scripts", "lib");
	const wantLib = fs
		.readdirSync(srcLib)
		.filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
		.sort();
	const dstLib = path.join(dest, "scripts", "lib");
	const gotLib = fs.existsSync(dstLib)
		? fs
				.readdirSync(dstLib)
				.filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
				.sort()
		: [];
	check(
		"all scripts/lib/ modules landed",
		wantLib.length > 0 && wantLib.join(",") === gotLib.join(","),
		`want=${wantLib.length} got=${gotLib.length}`,
	);
	const libDrift = wantLib.filter(
		(f) =>
			!gotLib.includes(f) || !fs.readFileSync(path.join(srcLib, f)).equals(fs.readFileSync(path.join(dstLib, f))),
	);
	check("scripts/lib/ modules are byte-identical to source", libDrift.length === 0, `drift: ${libDrift.join(", ")}`);

	// 4) Skills del proyecto aterrizaron. Las required deben; las optional (local-only), solo si existen en source.
	for (const s of REQUIRED_SKILLS) {
		check(`skill '${s}' landed`, fs.existsSync(path.join(dest, "skills", s, "SKILL.md")));
	}
	for (const s of OPTIONAL_SKILLS) {
		if (fs.existsSync(path.join(REPO_ROOT, ".claude", "skills", s, "SKILL.md"))) {
			check(
				`optional skill '${s}' landed (present on disk)`,
				fs.existsSync(path.join(dest, "skills", s, "SKILL.md")),
			);
		}
	}

	// 5) La referencia de primitives aterrizó (sourceada desde .pi canónico): byte-idéntica, README incluido.
	const srcPrim = path.join(REPO_ROOT, ".pi", "skills", "ultracode", "reference", "primitives");
	const wantPrim = fs
		.readdirSync(srcPrim)
		.filter((f) => f.endsWith(".md"))
		.sort();
	const dstPrim = path.join(dest, "skills", "ultracode", "reference", "primitives");
	const gotPrim = fs.existsSync(dstPrim)
		? fs
				.readdirSync(dstPrim)
				.filter((f) => f.endsWith(".md"))
				.sort()
		: [];
	check(
		"all primitives docs landed",
		wantPrim.length > 0 && wantPrim.join(",") === gotPrim.join(","),
		`want=${wantPrim.length} got=${gotPrim.length}`,
	);
	const primDrift = wantPrim.filter(
		(f) =>
			!gotPrim.includes(f) ||
			fs.readFileSync(path.join(srcPrim, f), "utf8") !== fs.readFileSync(path.join(dstPrim, f), "utf8"),
	);
	check("primitives docs are byte-identical to canonical", primDrift.length === 0, `drift: ${primDrift.join(", ")}`);

	// 6) --check idempotente justo después de un sync: sin drift.
	const chk = run(dest, ["--check"]);
	check("--check is in sync after sync", chk.status === 0, `exit=${chk.status}`);

	// 7) Control negativo: tampeá un archivo syncado → --check debe detectar drift.
	fs.appendFileSync(path.join(dest, "skills", "ultracode", "SKILL.md"), "\n<!-- tampered -->\n");
	const chk2 = run(dest, ["--check"]);
	check("--check detects drift (negative control)", chk2.status === 1, `exit=${chk2.status}`);

	// 8) Sin prune: la skill ajena global-only sobrevivió.
	check("foreign global-only skill survived (no prune)", fs.existsSync(path.join(foreign, "SKILL.md")));

	fs.rmSync(dest, { recursive: true, force: true });
	finish();
}

function finish() {
	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
		process.exit(1);
	}
}

main();
