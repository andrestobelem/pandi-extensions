/**
 * Test durable para scripts/sync-claude-global.mjs: la tool de operador que espeja los assets
 * Claude-facing de este repo en un home global de Claude Code (default ~/.claude).
 *
 * El destino es inyectable (--dest <dir> / CLAUDE_GLOBAL_DIR) precisamente para que este test pueda
 * correr contra un tmp dir descartable y nunca tocar el $HOME real. Fuente de verdad = el repo.
 *
 * Esto pinea:
 *   - Sin argumentos solo informa: nunca escribe en el home global.
 *   - Landing: después de `install`, el set gestionado existe en destino: workflows (todos los .js +
 *     README), el script runtime (build-workflow-artifact.mjs), las skills del proyecto y la
 *     referencia de primitives ultracode (sourceada desde .pi canónico).
 *   - --check idempotente: inmediatamente después de un sync, `--check` sale 0 (sin drift).
 *   - Sensibilidad (control negativo): tampear un archivo syncado hace que `--check` salga 1, así el
 *     check no es vacuo.
 *   - Remove seguro: elimina archivos byte-idénticos registrados por el manifiesto, conserva los
 *     modificados y todo contenido global ajeno.
 *
 * Sin build de extensión / sin modelo: test puro de filesystem + proceso de script.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/guards/sync-claude-global.test.mjs
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const SYNC = path.join(REPO_ROOT, "scripts", "sync-claude-global.mjs");
const MANIFEST = ".pandi-extensions-managed.json";

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

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function main() {
	check("sync-claude-global.mjs exists", fs.existsSync(SYNC));
	if (!fs.existsSync(SYNC)) return finish();

	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-"));

	// Fixture no-prune: una skill ajena global-only que debe sobrevivir al sync.
	const foreign = path.join(dest, "skills", "supacode-cli");
	fs.mkdirSync(foreign, { recursive: true });
	fs.writeFileSync(path.join(foreign, "SKILL.md"), "# foreign global-only skill\n");

	// 1) El default es status read-only: falta la instalación, no crea nada.
	const initial = run(dest);
	check("default status reports not installed", initial.status === 1, `exit=${initial.status}`);
	check("default status does not write managed files", !fs.existsSync(path.join(dest, "workflows")));
	check("default status does not create ownership manifest", !fs.existsSync(path.join(dest, MANIFEST)));

	// 2) Install explícito al destino tmp.
	const res = run(dest, ["install"]);
	check(
		"install exits 0",
		res.status === 0,
		`exit=${res.status} ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" | ")}`,
	);
	check("install writes ownership manifest", fs.existsSync(path.join(dest, MANIFEST)));
	const installedManifest = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), "utf8"));
	check(
		"ownership manifest contains unique destinations",
		new Set(installedManifest.files.map((entry) => entry.path)).size === installedManifest.files.length,
	);

	// 3) Workflows aterrizaron (todos los .js de .claude/workflows + README).
	const srcWf = path.join(REPO_ROOT, ".claude", "workflows");
	const wantWf = fs.readdirSync(srcWf).filter((f) => f.endsWith(".js")).length;
	const gotWf = fs.existsSync(path.join(dest, "workflows"))
		? fs.readdirSync(path.join(dest, "workflows")).filter((f) => f.endsWith(".js")).length
		: 0;
	check("all workflow .js landed", gotWf === wantWf && wantWf > 0, `want=${wantWf} got=${gotWf}`);
	check("workflows README landed", fs.existsSync(path.join(dest, "workflows", "README.md")));

	// 4) Script runtime aterrizó.
	check(
		"build-workflow-artifact.mjs landed",
		fs.existsSync(path.join(dest, "scripts", "build-workflow-artifact.mjs")),
	);

	// 4b) Su árbol de dependencias lib/ también aterrizó, byte-idéntico; si no, el
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

	// 5) Skills del proyecto aterrizaron. Las required deben; las optional (local-only), solo si existen en source.
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

	// 6) La referencia de primitives aterrizó (sourceada desde .pi canónico): byte-idéntica, README incluido.
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

	// 7) Status y --check idempotentes justo después de install: sin drift y sin writes.
	const status = run(dest, ["status"]);
	check("explicit status is in sync after install", status.status === 0, `exit=${status.status}`);
	const chk = run(dest, ["--check"]);
	check("--check is in sync after sync", chk.status === 0, `exit=${chk.status}`);

	// 8) Una source eliminada converge: status detecta stale e install borra solo stale owned sin cambios.
	const stale = path.join(dest, "skills", "removed-source", "SKILL.md");
	fs.mkdirSync(path.dirname(stale), { recursive: true });
	fs.writeFileSync(stale, "# stale managed\n");
	const manifestWithStale = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), "utf8"));
	manifestWithStale.files.push({ path: "skills/removed-source/SKILL.md", sha256: sha256("# stale managed\n") });
	fs.writeFileSync(path.join(dest, MANIFEST), `${JSON.stringify(manifestWithStale, null, 2)}\n`);
	const staleStatus = run(dest, ["status"]);
	check("status detects stale managed entries", staleStatus.status === 1, `exit=${staleStatus.status}`);
	const staleInstall = run(dest, ["install"]);
	check("install prunes unchanged stale managed entries", staleInstall.status === 0, `exit=${staleInstall.status}`);
	check("install removes unchanged stale managed file", !fs.existsSync(stale));

	// 9) Stale modificado también se conserva y aborta antes de writes.
	fs.mkdirSync(path.dirname(stale), { recursive: true });
	fs.writeFileSync(stale, "# stale managed\nmodified\n");
	const manifestWithModifiedStale = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), "utf8"));
	manifestWithModifiedStale.files.push({
		path: "skills/removed-source/SKILL.md",
		sha256: sha256("# stale managed\n"),
	});
	fs.writeFileSync(path.join(dest, MANIFEST), `${JSON.stringify(manifestWithModifiedStale, null, 2)}\n`);
	const modifiedStaleInstall = run(dest, ["install"]);
	check("install refuses modified stale managed entries", modifiedStaleInstall.status === 1);
	check("install preserves modified stale managed file", fs.readFileSync(stale, "utf8").includes("modified"));
	manifestWithModifiedStale.files = manifestWithModifiedStale.files.filter(
		(entry) => entry.path !== "skills/removed-source/SKILL.md",
	);
	fs.writeFileSync(path.join(dest, MANIFEST), `${JSON.stringify(manifestWithModifiedStale, null, 2)}\n`);
	fs.rmSync(stale, { force: true });

	// 10) Control negativo: tampeá un archivo syncado → status detecta drift.
	const tampered = path.join(dest, "skills", "ultracode", "SKILL.md");
	fs.appendFileSync(tampered, "\n<!-- tampered -->\n");
	const chk2 = run(dest, ["--check"]);
	check("--check detects drift (negative control)", chk2.status === 1, `exit=${chk2.status}`);

	// 11) Remove borra solo managed sin cambios: conserva el tampeado y lo ajeno, y reporta parcial.
	const removed = run(dest, ["remove"]);
	check("remove reports modified managed files", removed.status === 1, `exit=${removed.status}`);
	check("remove preserves modified managed file", fs.existsSync(tampered));
	check(
		"remove deletes unchanged managed file",
		!fs.existsSync(path.join(dest, "scripts", "build-workflow-artifact.mjs")),
	);
	check("remove preserves foreign global-only skill", fs.existsSync(path.join(foreign, "SKILL.md")));
	check("partial remove keeps ownership manifest", fs.existsSync(path.join(dest, MANIFEST)));

	// 12) Install no pisa el managed modificado. Cuando vuelve a los bytes registrados, puede completar y remover.
	const reinstalled = run(dest, ["install"]);
	check("install refuses modified managed files", reinstalled.status === 1, `exit=${reinstalled.status}`);
	check("failed install preserves modified managed file", fs.readFileSync(tampered, "utf8").includes("tampered"));
	fs.copyFileSync(path.join(REPO_ROOT, ".claude", "skills", "ultracode", "SKILL.md"), tampered);
	const completed = run(dest, ["install"]);
	check("install accepts a managed file restored to its hash", completed.status === 0, `exit=${completed.status}`);
	const removedClean = run(dest, ["remove"]);
	check("clean remove exits 0", removedClean.status === 0, `exit=${removedClean.status}`);
	check("clean remove deletes managed files", !fs.existsSync(tampered));
	check("clean remove deletes ownership manifest", !fs.existsSync(path.join(dest, MANIFEST)));
	check("clean remove still preserves foreign skill", fs.existsSync(path.join(foreign, "SKILL.md")));

	// 13) Sin manifiesto no hay ownership: ni remove ni install adoptan un archivo legacy byte-idéntico.
	const legacyDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-legacy-"));
	const legacyFile = path.join(legacyDest, "workflows", "README.md");
	fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
	fs.copyFileSync(path.join(REPO_ROOT, ".claude", "workflows", "README.md"), legacyFile);
	const legacyRemove = run(legacyDest, ["remove"]);
	check("remove without manifest is idempotent", legacyRemove.status === 0, `exit=${legacyRemove.status}`);
	check("remove without manifest preserves legacy file", fs.existsSync(legacyFile));
	const legacyInstall = run(legacyDest, ["install"]);
	check("install refuses a byte-identical unowned file", legacyInstall.status === 1, `exit=${legacyInstall.status}`);
	check("failed legacy install preserves the file", fs.existsSync(legacyFile));
	check("failed legacy install does not claim ownership", !fs.existsSync(path.join(legacyDest, MANIFEST)));

	// 14) Una colisión unowned aborta antes de escribir y un manifiesto ajeno nunca se reemplaza.
	const collisionDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-collision-"));
	const collisionFile = path.join(collisionDest, "workflows", "README.md");
	fs.mkdirSync(path.dirname(collisionFile), { recursive: true });
	fs.writeFileSync(collisionFile, "# user-owned\n");
	const collisionInstall = run(collisionDest, ["install"]);
	check("install refuses an unowned collision", collisionInstall.status === 1, `exit=${collisionInstall.status}`);
	check("install preserves an unowned collision", fs.readFileSync(collisionFile, "utf8") === "# user-owned\n");
	check(
		"collision preflight prevents partial writes",
		!fs.existsSync(path.join(collisionDest, "scripts", "build-workflow-artifact.mjs")),
	);
	check("collision does not create ownership manifest", !fs.existsSync(path.join(collisionDest, MANIFEST)));

	const parentFileDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-parent-file-"));
	fs.writeFileSync(path.join(parentFileDest, "skills"), "user-owned parent\n");
	const parentFileInstall = run(parentFileDest, ["install"]);
	check("install refuses a regular-file ancestor", parentFileInstall.status === 1, `exit=${parentFileInstall.status}`);
	check(
		"install preserves a regular-file ancestor",
		fs.readFileSync(path.join(parentFileDest, "skills"), "utf8") === "user-owned parent\n",
	);
	check("parent-file preflight prevents workflow writes", !fs.existsSync(path.join(parentFileDest, "workflows")));
	check("parent-file preflight prevents script writes", !fs.existsSync(path.join(parentFileDest, "scripts")));
	check("parent-file preflight does not create a manifest", !fs.existsSync(path.join(parentFileDest, MANIFEST)));

	const foreignManifestDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-foreign-manifest-"));
	const foreignManifest = path.join(foreignManifestDest, MANIFEST);
	fs.writeFileSync(foreignManifest, "user-owned manifest\n");
	const foreignManifestInstall = run(foreignManifestDest, ["install"]);
	check(
		"install refuses a foreign manifest",
		foreignManifestInstall.status === 1,
		`exit=${foreignManifestInstall.status}`,
	);
	check("install preserves a foreign manifest", fs.readFileSync(foreignManifest, "utf8") === "user-owned manifest\n");
	check("foreign manifest preflight prevents writes", !fs.existsSync(path.join(foreignManifestDest, "workflows")));

	const symlinkDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-symlink-"));
	const outside = path.join(os.tmpdir(), `claude-global-outside-${process.pid}.md`);
	fs.writeFileSync(outside, "# outside\n");
	fs.mkdirSync(path.join(symlinkDest, "workflows"), { recursive: true });
	fs.symlinkSync(outside, path.join(symlinkDest, "workflows", "README.md"));
	const symlinkInstall = run(symlinkDest, ["install"]);
	check("install refuses a symlink collision", symlinkInstall.status === 1, `exit=${symlinkInstall.status}`);
	check("install does not follow a symlink collision", fs.readFileSync(outside, "utf8") === "# outside\n");

	const danglingDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-dangling-"));
	const danglingTarget = path.join(os.tmpdir(), `claude-global-dangling-target-${process.pid}.md`);
	fs.mkdirSync(path.join(danglingDest, "workflows"), { recursive: true });
	fs.symlinkSync(danglingTarget, path.join(danglingDest, "workflows", "README.md"));
	const danglingInstall = run(danglingDest, ["install"]);
	check(
		"install refuses a dangling symlink collision",
		danglingInstall.status === 1,
		`exit=${danglingInstall.status}`,
	);
	check("install does not create a dangling symlink target", !fs.existsSync(danglingTarget));

	const danglingManifestDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-dangling-manifest-"));
	const danglingManifestTarget = path.join(os.tmpdir(), `claude-global-dangling-manifest-target-${process.pid}.json`);
	fs.symlinkSync(danglingManifestTarget, path.join(danglingManifestDest, MANIFEST));
	const danglingManifestInstall = run(danglingManifestDest, ["install"]);
	check("install refuses a dangling manifest symlink", danglingManifestInstall.status === 1);
	check("install does not create a dangling manifest target", !fs.existsSync(danglingManifestTarget));

	const danglingRemoveDest = fs.mkdtempSync(path.join(os.tmpdir(), "claude-global-dangling-remove-"));
	const danglingRemoveTarget = path.join(os.tmpdir(), `claude-global-dangling-remove-target-${process.pid}.md`);
	fs.mkdirSync(path.join(danglingRemoveDest, "workflows"), { recursive: true });
	fs.symlinkSync(danglingRemoveTarget, path.join(danglingRemoveDest, "workflows", "README.md"));
	fs.writeFileSync(
		path.join(danglingRemoveDest, MANIFEST),
		`${JSON.stringify(
			{
				owner: "pandi-extensions",
				version: 1,
				files: [{ path: "workflows/README.md", sha256: "0".repeat(64) }],
			},
			null,
			2,
		)}\n`,
	);
	const danglingRemove = run(danglingRemoveDest, ["remove"]);
	check("remove preserves a dangling managed symlink", danglingRemove.status === 1);
	check("remove keeps ownership for a dangling symlink", fs.existsSync(path.join(danglingRemoveDest, MANIFEST)));
	check("remove does not create a dangling managed target", !fs.existsSync(danglingRemoveTarget));

	fs.rmSync(dest, { recursive: true, force: true });
	fs.rmSync(legacyDest, { recursive: true, force: true });
	fs.rmSync(collisionDest, { recursive: true, force: true });
	fs.rmSync(parentFileDest, { recursive: true, force: true });
	fs.rmSync(foreignManifestDest, { recursive: true, force: true });
	fs.rmSync(symlinkDest, { recursive: true, force: true });
	fs.rmSync(outside, { force: true });
	fs.rmSync(danglingDest, { recursive: true, force: true });
	fs.rmSync(danglingTarget, { force: true });
	fs.rmSync(danglingManifestDest, { recursive: true, force: true });
	fs.rmSync(danglingManifestTarget, { force: true });
	fs.rmSync(danglingRemoveDest, { recursive: true, force: true });
	fs.rmSync(danglingRemoveTarget, { force: true });
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
