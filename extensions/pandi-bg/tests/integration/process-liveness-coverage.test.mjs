#!/usr/bin/env node
/**
 * Cobertura de caracterización para extensions/pandi-bg/process-liveness.ts.
 *
 * Cubre las brechas que bg-jobs.test.mjs deja en los helpers puros de liveness/identidad: ramas
 * por error-code de probeProcessAlive, ramas de plataforma de readProcessStartId (parseo Linux
 * /proc, parseo `ps` darwin/BSD, absorción de errores) y degradación win32 de verifyProcessIdentity.
 *
 * Estos helpers leen el SO vía el GLOBAL `process` (process.kill / process.platform) y vía los
 * imports de MODULE `readFileSync` (node:fs) y `spawnSync` (node:child_process). Bundleamos el
 * módulo una vez con node:fs / node:child_process aliaseados a stubs inyectables (manejados por
 * globals), así podemos alimentar fixtures determinísticos para las ramas de plataforma sin
 * subprocess real ni acceso real a /proc, y temporalmente overrideamos process.platform /
 * process.kill (restaurados en finally) para ejercer cada rama en este host. El código fuente es
 * la fuente de verdad.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadModule } from "../../../shared/test/harness.mjs";
import { clearStubs, withKill, withPlatform } from "./platform-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// Bundlea process-liveness.ts con sus dos builtins de node aliaseados a stubs que delegan a
// globals, para que cada test pueda inyectar el comportamiento readFileSync/spawnSync exacto.
async function buildLiveness() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-liveness-cov-"));
	const fsStub = path.join(outDir, "stub-fs.mjs");
	const cpStub = path.join(outDir, "stub-cp.mjs");
	await fs.writeFile(
		fsStub,
		"export function readFileSync(...args) {\n" +
			'\tif (typeof globalThis.__bgReadFileSync === "function") return globalThis.__bgReadFileSync(...args);\n' +
			'\tthrow new Error("readFileSync not stubbed in this test");\n' +
			"}\n",
	);
	await fs.writeFile(
		cpStub,
		"export function spawnSync(...args) {\n" +
			'\tif (typeof globalThis.__bgSpawnSync === "function") return globalThis.__bgSpawnSync(...args);\n' +
			'\tthrow new Error("spawnSync not stubbed in this test");\n' +
			"}\n",
	);
	const url = await bundle({
		src: path.join(REPO_ROOT, "extensions", "pandi-bg", "process-liveness.ts"),
		outDir,
		outName: "process-liveness.mjs",
		aliases: { "node:fs": fsStub, "node:child_process": cpStub },
		npx: "--no-install",
	});
	return url;
}

function requireFunction(mod, name, label) {
	const fn = mod[name];
	check(`${label}: ${name} is exported`, typeof fn === "function", typeof fn);
	return typeof fn === "function" ? fn : undefined;
}

// --- ramas de código de error de probeProcessAlive ------------------------------------

function probeMapsErrorCodes(mod) {
	const probe = mod.probeProcessAlive;
	check("probe: probeProcessAlive is exported", typeof probe === "function", typeof probe);
	if (typeof probe !== "function") return;

	// EPERM = el proceso existe pero pertenece a otro usuario -> sigue "alive".
	const eperm = withKill(
		() => {
			const err = new Error("operation not permitted");
			err.code = "EPERM";
			throw err;
		},
		() => probe(424242),
	);
	check("probe: EPERM maps to alive (foreign-owned but live)", eperm === "alive", String(eperm));

	// Código inesperado/no relacionado -> "unknown" de mejor esfuerzo (nunca afirmar dead).
	const einval = withKill(
		() => {
			const err = new Error("invalid argument");
			err.code = "EINVAL";
			throw err;
		},
		() => probe(424242),
	);
	check("probe: unexpected code (EINVAL) maps to unknown", einval === "unknown", String(einval));

	// ESRCH = no existe tal proceso -> "dead" (reconfirma el mapeo documentado junto a EPERM).
	const esrch = withKill(
		() => {
			const err = new Error("no such process");
			err.code = "ESRCH";
			throw err;
		},
		() => probe(424242),
	);
	check("probe: ESRCH maps to dead", esrch === "dead", String(esrch));

	// Un error SIN code también cae a unknown.
	const noCode = withKill(
		() => {
			throw new Error("mysterious");
		},
		() => probe(424242),
	);
	check("probe: error without a code maps to unknown", noCode === "unknown", String(noCode));
}

// --- ramas de plataforma de readProcessStartId ----------------------------------------

function readStartIdLinuxBranch(mod) {
	const read = requireFunction(mod, "readProcessStartId", "startid-linux");
	if (!read) return;

	// Un /proc/<pid>/stat realista donde comm contiene espacios Y parens internos, así que el
	// parser debe cortar después del ÚLTIMO ')'. Los tokens after-comm son desde el campo 3, así
	// que starttime (campo 22, 1-indexed) cae en el índice 19 de esos tokens.
	const tokens = Array.from({ length: 22 }, (_, i) => (i === 19 ? "987654" : String(i)));
	const statLine = `1234 (weird )name) ${tokens.join(" ")}\n`;
	globalThis.__bgReadFileSync = (file) => {
		check("startid-linux: reads the pid's /proc stat file", file === "/proc/4321/stat", String(file));
		return statLine;
	};
	const result = withPlatform("linux", () => read(4321));
	clearStubs();
	check("startid-linux: parses starttime after last ')' as lin:<starttime>", result === "lin:987654", String(result));

	// Línea stat con muy pocos tokens post-comm (sin índice 19) -> undefined.
	globalThis.__bgReadFileSync = () => "1234 (comm) 3 4 5\n";
	const shortResult = withPlatform("linux", () => read(4321));
	clearStubs();
	check("startid-linux: missing starttime token yields undefined", shortResult === undefined, String(shortResult));
}

function readStartIdDarwinBranch(mod) {
	const read = requireFunction(mod, "readProcessStartId", "startid-darwin");
	if (!read) return;

	// status 0 con salida lstart -> ps:<trimmed output>.
	globalThis.__bgSpawnSync = (cmd, args) => {
		check("startid-darwin: shells out to ps -o lstart=", cmd === "ps" && args.includes("lstart="), `${cmd} ${args}`);
		return { status: 0, stdout: "Mon Jun 30 12:00:00 2024\n" };
	};
	const ok = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid-darwin: status 0 yields ps:<lstart>", ok === "ps:Mon Jun 30 12:00:00 2024", String(ok));

	// Status no cero -> la salida se trata como vacía -> undefined.
	globalThis.__bgSpawnSync = () => ({ status: 1, stdout: "Mon Jun 30 12:00:00 2024\n" });
	const failed = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid-darwin: non-zero status yields undefined", failed === undefined, String(failed));

	// status 0 pero stdout vacío -> undefined.
	globalThis.__bgSpawnSync = () => ({ status: 0, stdout: "   \n" });
	const empty = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid-darwin: empty stdout yields undefined", empty === undefined, String(empty));

	// La misma rama se alcanza para plataformas *bsd (platform.endsWith("bsd")).
	globalThis.__bgSpawnSync = () => ({ status: 0, stdout: "Tue Jul 1 09:00:00 2024\n" });
	const bsd = withPlatform("freebsd", () => read(4321));
	clearStubs();
	check("startid-bsd: *bsd reaches the ps branch", bsd === "ps:Tue Jul 1 09:00:00 2024", String(bsd));
}

function readStartIdSwallowsErrors(mod) {
	const read = requireFunction(mod, "readProcessStartId", "startid-errors");
	if (!read) return;

	// Linux: readFileSync lanza (p. ej. ENOENT) -> capturado -> undefined.
	globalThis.__bgReadFileSync = () => {
		const err = new Error("no such file");
		err.code = "ENOENT";
		throw err;
	};
	const linThrow = withPlatform("linux", () => read(4321));
	clearStubs();
	check("startid: a throwing readFileSync is swallowed to undefined", linThrow === undefined, String(linThrow));

	// darwin: spawnSync lanza -> capturado -> undefined.
	globalThis.__bgSpawnSync = () => {
		throw new Error("spawn blew up");
	};
	const darwinThrow = withPlatform("darwin", () => read(4321));
	clearStubs();
	check("startid: a throwing spawnSync is swallowed to undefined", darwinThrow === undefined, String(darwinThrow));
}

function readStartIdWin32Branch(mod) {
	const read = requireFunction(mod, "readProcessStartId", "startid-win32");
	if (!read) return;
	// win32 no entra en ninguna rama -> undefined (degradación graceful), sin llamadas a stubs.
	const result = withPlatform("win32", () => read(4321));
	check("startid-win32: unsupported platform yields undefined", result === undefined, String(result));
}

// --- degradación win32 de verifyProcessIdentity ---------------------------------------

function verifyWin32Degrades(mod) {
	const verify = mod.verifyProcessIdentity;
	check("verify: verifyProcessIdentity is exported", typeof verify === "function", typeof verify);
	if (typeof verify !== "function") return;
	// En win32, readProcessStartId(pid) es undefined, así que incluso CON un id registrado el
	// id actual es ilegible -> "unknown" (nunca afirma same/different).
	const result = withPlatform("win32", () => verify(4321, "ps:anything"));
	check("verify-win32: degrades to unknown when current id is unreadable", result === "unknown", String(result));
}

async function main() {
	const url = await buildLiveness();
	const mod = await loadModule(url);
	clearStubs();
	probeMapsErrorCodes(mod);
	readStartIdLinuxBranch(mod);
	readStartIdDarwinBranch(mod);
	readStartIdSwallowsErrors(mod);
	readStartIdWin32Branch(mod);
	verifyWin32Degrades(mod);
	clearStubs();

	console.log(`${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
