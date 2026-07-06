/**
 * Test para el helper compartido de negative-control crash-safe `withMutatedFile`
 * (extensions/shared/test/negative-control.mjs).
 *
 * Las suites de parity/drift prueban que su --check no sea vacuo sobrescribiendo temporalmente un archivo
 * TRACKED del repo, corriendo el check real, y luego restaurándolo en un `finally`. El peligro (design-review R4,
 * confirmado sistémico en 7 suites): si el proceso recibe SIGTERM/crashea ENTRE la mutación y
 * el finally-restore (el runner hard-killea una suite a los 120s), el archivo tracked queda dirty/medio
 * escrito. `withMutatedFile` mantiene la mutación in-place pero también registra un restore process-level
 * en SIGTERM/exit para que un hard kill todavía restaure el original.
 *
 * Esto pinea:
 *   1. Comportamiento: fn ve el contenido mutado; después, el archivo queda byte-restored.
 *   2. Throw-safety: si fn hace throw, el archivo igual se restaura (finally) y el throw propaga.
 *   3. Crash-safety (el punto): un proceso hijo SIGTERM'd a mitad de mutación igual restaura el archivo,
 *      vía el signal handler registrado — probado con un hijo real, no un mock.
 *   4. La mutación anidada del mismo archivo se rechaza en vez de perder el baseline original de restore.
 *   5. Atomicidad (issue #8): cada reemplazo aterriza vía rename (inode nuevo en POSIX), nunca
 *      truncando el archivo live — un lector concurrente (esbuild resolviendo el package.json root REAL
 *      mientras una suite de parity lo muta) nunca debe observar un archivo truncado.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/negative-control-guard.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HELPER = path.join(REPO_ROOT, "extensions", "shared", "test", "negative-control.mjs");

const { check, counts } = createChecker();

async function main() {
	check("negative-control.mjs exists", fs.existsSync(HELPER));
	const { withIsolatedRepoCopy, withMutatedFile } = await import(HELPER);

	// 1) Comportamiento: fn ve contenido mutado; el archivo se restaura después.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "negctl-"));
	const f = path.join(dir, "tracked.txt");
	const ORIGINAL = "original-content\n";
	fs.writeFileSync(f, ORIGINAL);
	let seen = null;
	const ret = await withMutatedFile(
		f,
		(orig) => `${orig}MUTATED`,
		(orig) => {
			seen = fs.readFileSync(f, "utf8");
			return orig.length;
		},
	);
	check("fn observes the mutated content", seen === `${ORIGINAL}MUTATED`, `seen=${JSON.stringify(seen)}`);
	check("fn receives the original as its arg (return threaded)", ret === ORIGINAL.length, `ret=${ret}`);
	check("file is byte-restored after withMutatedFile", fs.readFileSync(f, "utf8") === ORIGINAL);

	// 2) Throw-safety: el archivo se restaura aunque fn haga throw, y el error propaga.
	let threw = false;
	try {
		await withMutatedFile(f, "TEMP", () => {
			throw new Error("boom");
		});
	} catch {
		threw = true;
	}
	check("throw from fn propagates", threw);
	check("file restored after fn throws", fs.readFileSync(f, "utf8") === ORIGINAL);

	// 3) Aislamiento: los controles negativos que necesitan scripts reales deben mutar una copia del
	// repo, nunca los archivos tracked del checkout de trabajo.
	const realRootPackage = path.join(REPO_ROOT, "package.json");
	const realRootPackageOriginal = fs.readFileSync(realRootPackage, "utf8");
	let isolatedRoot = null;
	await withIsolatedRepoCopy(REPO_ROOT, async (copyRoot) => {
		isolatedRoot = copyRoot;
		const copiedRootPackage = path.join(copyRoot, "package.json");
		check("isolated repo copy contains tracked package.json", fs.existsSync(copiedRootPackage));
		fs.writeFileSync(copiedRootPackage, `${fs.readFileSync(copiedRootPackage, "utf8")}\n<!-- isolated drift -->\n`);
		check(
			"mutating the isolated copy does not alter the real tracked package.json",
			fs.readFileSync(realRootPackage, "utf8") === realRootPackageOriginal,
		);
	});
	check("isolated repo copy is removed after callback", isolatedRoot !== null && !fs.existsSync(isolatedRoot));

	// 4) Crash-safety: un hijo SIGTERM'd a mitad de mutación igual restaura el archivo vía el signal guard.
	const marker = path.join(dir, "child-target.txt");
	fs.writeFileSync(marker, ORIGINAL);
	const childSrc = `
import { withMutatedFile } from ${JSON.stringify(HELPER)};
const f = ${JSON.stringify(marker)};
await withMutatedFile(f, "DIRTY-BY-CHILD", async () => {
  process.send?.("mutated");
  console.log("MUTATED");
  await new Promise((r) => setTimeout(r, 10000)); // hang so the parent can SIGTERM us mid-mutation
});
`;
	const childFile = path.join(dir, "child.mjs");
	fs.writeFileSync(childFile, childSrc);
	// Corre el hijo, dejalo mutar, luego mandale SIGTERM; el signal guard debe restaurar antes de salir.
	const crash = spawnSync(
		process.execPath,
		[
			"-e",
			`const { spawn } = require('node:child_process');
			 const child = spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: ['ignore','pipe','inherit'] });
			 let observedMutation = false;
			 const timeout = setTimeout(() => {
			   console.error('timeout waiting for MUTATED marker');
			   child.kill('SIGKILL');
			   process.exit(2);
			 }, 5000);
			 child.stdout.on('data', (d) => {
			   const text = String(d);
			   process.stdout.write(text);
			   if (!observedMutation && text.includes('MUTATED')) {
			     observedMutation = true;
			     console.log('PARENT_OBSERVED_MUTATED');
			     setTimeout(() => {
			       const sent = child.kill('SIGTERM');
			       console.log('PARENT_SENT_SIGTERM=' + sent);
			     }, 50);
			   }
			 });
			 child.on('error', (error) => {
			   clearTimeout(timeout);
			   console.error(String(error && error.stack || error));
			   process.exit(3);
			 });
			 child.on('exit', (code, signal) => {
			   clearTimeout(timeout);
			   if (!observedMutation) {
			     console.error('child exited before MUTATED marker: code=' + code + ' signal=' + signal);
			     process.exit(4);
			   }
			   if (!(code === 143 || signal === 'SIGTERM')) {
			     console.error('child did not exit from SIGTERM handler: code=' + code + ' signal=' + signal);
			     process.exit(5);
			   }
			   console.log('PARENT_OBSERVED_SIGTERM_EXIT');
			   process.exit(0);
			 });`,
		],
		{ encoding: "utf8", timeout: 20000 },
	);
	const crashDetails = `status=${crash.status} signal=${crash.signal} stdout=${JSON.stringify(crash.stdout)} stderr=${JSON.stringify(crash.stderr)}`;
	check("crash harness wrapper exits cleanly", crash.status === 0, crashDetails);
	check(
		"crash harness observed the child mutation marker before killing it",
		crash.stdout.includes("PARENT_OBSERVED_MUTATED"),
		crashDetails,
	);
	check(
		"crash harness observed the child SIGTERM-handler exit",
		crash.stdout.includes("PARENT_OBSERVED_SIGTERM_EXIT"),
		crashDetails,
	);
	const afterKill = fs.readFileSync(marker, "utf8");
	check(
		"file restored after child SIGTERM'd mid-mutation (crash-safe guard)",
		afterKill === ORIGINAL,
		`after=${JSON.stringify(afterKill)}`,
	);

	// 5) Mutación anidada del mismo archivo: rechazar en vez de sobrescribir el baseline de restore.
	let nestedRejected = false;
	await withMutatedFile(f, "OUTER", async () => {
		try {
			await withMutatedFile(f, "INNER", () => undefined);
		} catch (error) {
			nestedRejected = /already being mutated/.test(String(error?.message || error));
		}
		check("nested same-file mutation is rejected", nestedRejected);
		check("outer mutation remains active after nested rejection", fs.readFileSync(f, "utf8") === "OUTER");
	});
	check("file restored after rejected nested mutation", fs.readFileSync(f, "utf8") === ORIGINAL);

	// 6) Atomicidad (issue #8): las suites corren en un pool paralelo y esbuild (cwd = repo root)
	// resuelve el package.json root REAL mientras las suites de parity lo mutan in-place. Un
	// fs.writeFileSync in-place trunca antes de escribir, así que un lector paralelo puede observar un archivo VACÍO
	// (CI: "Unexpected end of file in JSON — package.json:1:0"). Pineá el mecanismo atómico
	// determinísticamente: cada reemplazo debe aterrizar vía rename — un inode NUEVO en POSIX — nunca
	// truncando el inode live.
	if (process.platform !== "win32") {
		const g = path.join(dir, "atomic-target.txt");
		fs.writeFileSync(g, ORIGINAL);
		const inoBefore = fs.statSync(g).ino;
		let inoDuring = null;
		await withMutatedFile(g, "ATOMIC-MUTATED", () => {
			inoDuring = fs.statSync(g).ino;
		});
		const inoAfter = fs.statSync(g).ino;
		check(
			"mutation lands via rename, not in-place truncate (new inode)",
			inoDuring !== null && inoDuring !== inoBefore,
			`before=${inoBefore} during=${inoDuring}`,
		);
		check(
			"restore lands via rename, not in-place truncate (new inode)",
			inoAfter !== inoDuring,
			`during=${inoDuring} after=${inoAfter}`,
		);
		check(
			"no temp sibling left behind next to the target",
			fs.readdirSync(dir).filter((n) => n.startsWith("atomic-target.txt.")).length === 0,
			fs.readdirSync(dir).join(","),
		);
		check("content byte-restored after atomic mutate+restore", fs.readFileSync(g, "utf8") === ORIGINAL);
	} else {
		check("atomicity pin skipped on win32 (inode semantics)", true);
	}

	fs.rmSync(dir, { recursive: true, force: true });

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
