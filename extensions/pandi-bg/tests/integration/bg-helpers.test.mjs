#!/usr/bin/env node
/**
 * Tests unitarios para los helpers PURE/file en extensions/pandi-bg que la auditoría de
 * cobertura marcó como de alto riesgo pero sin tests:
 *   - storage.ts: validJobId (guard de path traversal), lstatPlainDirectory,
 *     lstatPlainDirectoryChain, ensurePlainDirectory (rechazo de symlink/non-dir).
 *   - runtime-state.ts: asString / asNumber (coerción de finite-number).
 *
 * Estos guards existen para impedir que un job id malicioso/buggy o un path symlinkeado escape
 * del directorio de bg runs, así que merecen cobertura directa. Se usan fixtures reales de
 * filesystem (tmpdir) para la cadena lstat, de modo que el comportamiento de symlink se ejerza,
 * no quede mockeado.
 *
 * Ejecutar:
 *   node extensions/pandi-bg/tests/integration/bg-helpers.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function whenSymlinkSupported(label, symlinkOk, run) {
	if (!symlinkOk) {
		console.log(`SKIP: ${label}: symlink unsupported here`);
		check(`${label}: skipped because symlink unsupported here`, true);
		return;
	}
	await run();
}

async function scenarioStorage(url) {
	const { validJobId, lstatPlainDirectory, lstatPlainDirectoryChain, ensurePlainDirectory } = await loadModule(url);

	// --- validJobId: guard de path traversal / hidden-file ---
	const valid = ["bg-abc_1.2", "A", "abc123", "x.y-z_2", "bg-lq3k9-1a2b3c4d"];
	for (const id of valid) check(`validJobId accepts: ${JSON.stringify(id)}`, validJobId(id) === true);
	const invalid = ["", ".", "..", ".hidden", ".audit.jsonl", "../x", "a/b", "-leading", "a b", "a\\b", "..\\x"];
	for (const id of invalid) check(`validJobId rejects: ${JSON.stringify(id)}`, validJobId(id) === false);

	// --- fixtures de filesystem para los guards lstat ---
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-storage-"));
	try {
		const realDir = path.join(tmp, "realdir");
		const nested = path.join(realDir, "a", "b");
		await fs.mkdir(nested, { recursive: true });
		const regularFile = path.join(tmp, "file.txt");
		await fs.writeFile(regularFile, "x");
		const symlinkToDir = path.join(tmp, "linkdir");
		let symlinkOk = true;
		try {
			await fs.symlink(realDir, symlinkToDir, "dir");
		} catch {
			symlinkOk = false; // algunas plataformas/CI prohíben crear symlinks
		}
		const missing = path.join(tmp, "nope");

		check("lstatPlainDirectory true for a real dir", (await lstatPlainDirectory(realDir)) === true);
		check("lstatPlainDirectory false for a regular file", (await lstatPlainDirectory(regularFile)) === false);
		check(
			"lstatPlainDirectory false for a missing path (ENOENT swallowed)",
			(await lstatPlainDirectory(missing)) === false,
		);
		await whenSymlinkSupported("lstatPlainDirectory symlink case", symlinkOk, async () => {
			check("lstatPlainDirectory false for a symlink-to-dir", (await lstatPlainDirectory(symlinkToDir)) === false);
		});

		// chain: true solo cuando todo componente es un dir real sin symlink bajo base.
		check(
			"lstatPlainDirectoryChain true for nested real dirs under base",
			(await lstatPlainDirectoryChain(realDir, nested)) === true,
		);
		check(
			"lstatPlainDirectoryChain false for a target outside base ('..')",
			(await lstatPlainDirectoryChain(realDir, path.join(tmp, "elsewhere"))) === false,
		);
		check(
			"lstatPlainDirectoryChain false for an absolute escape",
			(await lstatPlainDirectoryChain(realDir, "/")) === false,
		);
		// base === target produce un relative vacío, que el guard rechaza (la chain solo se
		// consulta sobre un HIJO de base; same-dir se trata como fuera de alcance → false).
		check(
			"lstatPlainDirectoryChain false for base === target (empty relative rejected)",
			(await lstatPlainDirectoryChain(realDir, realDir)) === false,
		);
		await whenSymlinkSupported("lstatPlainDirectoryChain symlink-component case", symlinkOk, async () => {
			const throughLink = path.join(symlinkToDir, "a");
			check(
				"lstatPlainDirectoryChain false when a component is symlinked",
				(await lstatPlainDirectoryChain(tmp, throughLink)) === false,
			);
		});

		// ensurePlainDirectory: crea, tolera EEXIST, rechaza non-dir / symlink.
		const fresh = path.join(tmp, "fresh");
		await ensurePlainDirectory(fresh);
		check("ensurePlainDirectory creates a fresh dir", (await lstatPlainDirectory(fresh)) === true);
		let secondThrew = false;
		try {
			await ensurePlainDirectory(fresh); // EEXIST tolerado
		} catch {
			secondThrew = true;
		}
		check("ensurePlainDirectory tolerates EEXIST on second call", secondThrew === false);

		let fileThrew = false;
		try {
			await ensurePlainDirectory(regularFile); // existe pero es un archivo
		} catch (e) {
			fileThrew = /Se rechaza usar algo que no es un directorio o es un symlink/.test(String(e?.message));
		}
		check("ensurePlainDirectory refuses an existing regular file", fileThrew === true);

		await whenSymlinkSupported("ensurePlainDirectory symlink-refusal case", symlinkOk, async () => {
			let linkThrew = false;
			try {
				await ensurePlainDirectory(symlinkToDir);
			} catch (e) {
				linkThrew = /Se rechaza usar algo que no es un directorio o es un symlink/.test(String(e?.message));
			}
			check("ensurePlainDirectory refuses a symlink-to-dir", linkThrew === true);
		});
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

async function scenarioRuntimeState(url) {
	const { asNumber, asString } = await loadModule(url);

	check("asNumber returns finite numbers", asNumber(42) === 42 && asNumber(0) === 0 && asNumber(-3.5) === -3.5);
	check(
		"asNumber rejects NaN/Infinity",
		asNumber(NaN) === undefined && asNumber(Infinity) === undefined && asNumber(-Infinity) === undefined,
	);
	check(
		"asNumber rejects non-numbers",
		asNumber("42") === undefined &&
			asNumber(null) === undefined &&
			asNumber(undefined) === undefined &&
			asNumber({}) === undefined,
	);

	check("asString returns strings", asString("hi") === "hi" && asString("") === "");
	check(
		"asString rejects non-strings",
		asString(42) === undefined &&
			asString(null) === undefined &&
			asString(undefined) === undefined &&
			asString({}) === undefined,
	);
}

async function main() {
	const storage = await buildExtension({
		name: "pi-bg-storage-helpers",
		src: path.join(REPO_ROOT, "extensions", "pandi-bg", "storage.ts"),
		outName: "storage.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
	try {
		await scenarioStorage(storage.url);
	} finally {
		await fs.rm(storage.outDir, { recursive: true, force: true });
	}

	const runtimeState = await buildExtension({
		name: "pi-bg-runtime-state-helpers",
		src: path.join(REPO_ROOT, "extensions", "pandi-bg", "runtime-state.ts"),
		outName: "runtime-state.mjs",
	});
	try {
		await scenarioRuntimeState(runtimeState.url);
	} finally {
		await fs.rm(runtimeState.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
