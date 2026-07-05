#!/usr/bin/env node
/**
 * Corre secuencialmente todas las suites de integración durables de paquetes Pi.
 *
 * Fuente de verdad = DISCOVERY por convención: se corre cada
 * `extensions/<ext>/tests/integration/*.test.mjs`. Cada extensión trae sus propias
 * suites, así que agregar una no exige editar nada acá — este runner solo orquesta y agrega.
 * Una suite que todavía no se espera que esté verde se excluye SOLO listándola explícitamente
 * en `ignoredDraftSuites` (con una razón); nunca se saltea nada en silencio.
 *
 * `npm test` delega acá después del typecheck. También podés correr la
 * suite de comportamiento directamente mientras iterás:
 *
 *   node scripts/test/run-all.mjs
 *   node scripts/test/run-all.mjs --list
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const allowedArgs = new Set(["--list", "--serial"]);
const unknownArgs = rawArgs.filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length) {
	console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
	console.error("Usage: node scripts/test/run-all.mjs [--list] [--serial]");
	process.exit(1);
}

const SUITE_TIMEOUT_MS = 120_000;
const SUITE_KILL_GRACE_MS = 5_000;
// Las suites están aisladas por proceso (tempdir propio + child + import con cache-bust), así que corren en un
// pool paralelo acotado para dar feedback rápido. El tope es conservador (default min(cpus,4)) para limitar la
// contención de CPU que podría desestabilizar las pocas suites sensibles al timing; se puede overridear con TEST_CONCURRENCY o --serial.
const CONCURRENCY = args.has("--serial")
	? 1
	: Math.max(1, Number(process.env.TEST_CONCURRENCY) || Math.min(4, os.cpus().length || 4));
const EXTENSIONS_DIR = "extensions";
const SUITE_SUBDIR = path.posix.join("tests", "integration");

// Las draft suites se excluyen, pero deben ser EXPLICIT (con una razón), para que una suite aún no verde
// nunca corra Y una suite verde nunca se saltee en silencio. Sacá una suite de acá cuando esté verde de forma confiable. Hoy está vacío.
const ignoredDraftSuites = new Set([]);

// Descubre por convención los directorios de suites: los extensions/<ext>/tests/integration que existan.
const extensionsDirAbs = path.join(REPO_ROOT, EXTENSIONS_DIR);
const suiteDirs = (fs.existsSync(extensionsDirAbs) ? fs.readdirSync(extensionsDirAbs, { withFileTypes: true }) : [])
	.filter((entry) => entry.isDirectory())
	.map((entry) => path.posix.join(EXTENSIONS_DIR, entry.name, SUITE_SUBDIR))
	.filter((dir) => fs.existsSync(path.join(REPO_ROOT, dir)))
	.sort();

// Descubre las suites: cada *.test.mjs bajo esos directorios.
const discoveredSuites = suiteDirs
	.flatMap((dir) =>
		fs
			.readdirSync(path.join(REPO_ROOT, dir))
			.filter((name) => name.endsWith(".test.mjs"))
			.map((name) => path.posix.join(dir, name)),
	)
	.sort();

const suites = discoveredSuites.filter((suite) => !ignoredDraftSuites.has(suite));

if (args.has("--list")) {
	for (const suite of suites) console.log(suite);
	for (const suite of ignoredDraftSuites) {
		if (fs.existsSync(path.join(REPO_ROOT, suite))) console.log(`# ignored draft: ${suite}`);
	}
	process.exit(0);
}

if (suites.length === 0) {
	console.error("No integration suites discovered under extensions/*/tests/integration");
	process.exit(1);
}

// Corre una suite en un child process, bufferizando su output (seguro en paralelo, a diferencia de `inherit` en vivo).
// Preserva la semántica de timeout+SIGTERM de la vieja ruta con spawnSync, con fallback a SIGKILL.
function runSuite(suite) {
	return new Promise((resolve) => {
		const started = Date.now();
		let out = "";
		let timedOut = false;
		let killTimer = null;
		const child = spawn(process.execPath, [path.join(REPO_ROOT, suite)], { cwd: REPO_ROOT, env: process.env });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), SUITE_KILL_GRACE_MS);
		}, SUITE_TIMEOUT_MS);
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		const done = (status, signal, errText) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			resolve({ suite, status, elapsedMs: Date.now() - started, signal, timedOut, out: out + (errText || "") });
		};
		child.on("close", (code, signal) => done(typeof code === "number" ? code : 1, signal));
		child.on("error", (err) => done(1, null, `\n${err}`));
	});
}

// Worker pool acotado: como mucho CONCURRENCY suites en vuelo; los resultados se mantienen en orden de suite.
const results = new Array(suites.length);
let nextIndex = 0;
async function worker() {
	while (nextIndex < suites.length) {
		const i = nextIndex++;
		const suite = suites[i];
		const result = await runSuite(suite);
		results[i] = result;
		const label = result.status === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
		// Imprime el output bufferizado de cada suite como un bloque coherente cuando termina.
		process.stdout.write(`\n=== ${suite}: ${label} (${Math.round(result.elapsedMs / 1000)}s) ===\n`);
		if (result.out) process.stdout.write(result.out.endsWith("\n") ? result.out : `${result.out}\n`);
	}
}

console.log(`Running ${suites.length} suites, concurrency ${CONCURRENCY}...`);
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, suites.length) }, () => worker()));

const failed = results.filter((result) => result.status !== 0);
console.log("\n=== integration summary ===");
for (const result of results) {
	const suffix = result.signal ? ` signal=${result.signal}` : "";
	const label = result.status === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
	console.log(`${label} ${result.suite} (${Math.round(result.elapsedMs / 1000)}s)${suffix}`);
}
console.log(`${results.length - failed.length}/${results.length} suites passed`);

process.exit(failed.length === 0 ? 0 : 1);
