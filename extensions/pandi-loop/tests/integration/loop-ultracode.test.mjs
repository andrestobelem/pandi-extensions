/**
 * Prueba de integración de comportamiento para la postura ULTRACODE de extensions/pandi-loop/index.ts.
 *
 * `npm test` es solo un TYPECHECK; no prueba nada sobre el comportamiento en runtime. Este archivo fija
 * el contrato observable del flag de postura `--ultracode` agregado a `/loop`:
 *   - `/loop --ultracode <task>` hace que el prompt ITERATION reinyectado lleve la guía ULTRACODE
 *     (apoyarse en dynamic workflows), mientras que un `/loop <task>` simple NO.
 *   - el flag se elimina del texto de la tarea y nunca se confunde con el token de intervalo final
 *     (`--ultracode <task> 5m` conserva la cadencia fija Y la postura).
 *   - la postura se persiste en el loop-state snapshot para que sobreviva una recarga.
 *
 * Mecanismo: pandi-loop inyecta cada prompt de iteración vía `pi.sendUserMessage`. Construimos el
 * index.ts ACTUAL a ESM (mismo patrón self-bootstrapping que loop-behavior.test.mjs), ejecutamos
 * el comando REAL `/loop` contra un pi/ctx mockeado, y capturamos sendUserMessage + los
 * snapshots loop-state persistidos. Afirmamos el texto OBSERVABLE del prompt y el snapshot.
 *
 * Ejecutarlo:
 *   node extensions/pandi-loop/tests/integration/loop-ultracode.test.mjs
 *
 * Exit code 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = el harness crasheó.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const TEST_PROJECT_ROOT = path.join(REPO_ROOT, ".pi", "tmp", "loop-ultracode-test");
let TEST_CTX_SEQ = 0;

const { check, counts } = createChecker();

async function buildLoop() {
	return await buildExtension({
		name: "pi-loop-ultracode",
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "index.ts"),
		outName: "loop.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const entries = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: () => {},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content) => sentMessages.push(content),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, entries, sentMessages };
}

function makeCtx() {
	const projectCwd = path.join(TEST_PROJECT_ROOT, `ctx-${++TEST_CTX_SEQ}`);
	return {
		mode: "tui",
		hasUI: true,
		cwd: projectCwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: () => {},
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => [] },
	};
}

function latestSnapshot(entries) {
	let snap;
	for (const e of entries) {
		if (e.customType === "loop-state" && e.data) snap = e.data;
	}
	return snap;
}

// Inicia un loop y captura el primer prompt de iteración inyectado (fireWake corre sincrónicamente).
async function startLoopAndCapture(loopUrl, args) {
	const loopExtension = await loadDefault(loopUrl);
	const ctx = makeCtx();
	const built = makePi();
	loopExtension(built.pi);
	await built.commands.get("loop").handler(args, ctx);
	return built;
}

// ===========================================================================
// ESCENARIO 1: `--ultracode` inyecta la guía ULTRACODE en el prompt de iteración.
// ===========================================================================
async function ultracodeInjectsGuidance(loopUrl) {
	const { sentMessages, entries } = await startLoopAndCapture(loopUrl, "--ultracode watch the build");
	const prompt = sentMessages[0] ?? "";
	check("ultracode: an iteration prompt was injected", sentMessages.length >= 1, `messages=${sentMessages.length}`);
	check("ultracode: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("ultracode: guidance mentions dynamic workflows", /dynamic workflows/i.test(prompt));
	check(
		"ultracode: flag stripped from the task",
		/TAREA \(textual\):\s*\nwatch the build/.test(prompt) && !/--ultracode/.test(prompt),
		prompt.slice(0, 200),
	);
	check("ultracode: posture is persisted on the snapshot", latestSnapshot(entries)?.ultracode === true);
}

// ===========================================================================
// ESCENARIO 2: el flag no se confunde con el intervalo final; la cadencia fija sobrevive.
// ===========================================================================
async function flagDoesNotEatInterval(loopUrl) {
	const { sentMessages, entries } = await startLoopAndCapture(loopUrl, "--ultracode watch the build 5m");
	const prompt = sentMessages[0] ?? "";
	const snap = latestSnapshot(entries);
	check("interval+flag: ULTRACODE guidance present", /ULTRACODE:/.test(prompt));
	check("interval+flag: posture persisted", snap?.ultracode === true);
	check("interval+flag: fixed mode preserved", snap?.mode === "fixed", `mode=${snap?.mode}`);
	check("interval+flag: interval is 5m (300000ms)", snap?.intervalMs === 300000, `intervalMs=${snap?.intervalMs}`);
	check("interval+flag: task is clean", snap?.task === "watch the build", `task=${snap?.task}`);
}

// ===========================================================================
// ESCENARIO 3: sin flag → sin texto ultracode, postura desactivada (caracteriza el default por omisión).
// ===========================================================================
async function defaultHasNoUltracode(loopUrl) {
	const { sentMessages, entries } = await startLoopAndCapture(loopUrl, "watch the build");
	const prompt = sentMessages[0] ?? "";
	check("default: an iteration prompt was injected", sentMessages.length >= 1);
	check("default: no ULTRACODE wording without the flag", !/ULTRACODE:/.test(prompt));
	check(
		"default: posture is off on the snapshot",
		!latestSnapshot(entries)?.ultracode,
		`ultracode=${latestSnapshot(entries)?.ultracode}`,
	);
}

async function main() {
	const { outDir, url } = await buildLoop();
	try {
		await ultracodeInjectsGuidance(url);
		await flagDoesNotEatInterval(url);
		await defaultHasNoUltracode(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
		await fs.rm(TEST_PROJECT_ROOT, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
