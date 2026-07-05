/**
 * Test de integración de comportamiento para la postura ULTRACODE de extensions/pandi-goal/index.ts.
 *
 * `npm test` solo hace TYPECHECK; no prueba nada sobre comportamiento runtime. Este archivo fija
 * el contrato observable del flag de postura `--ultracode` agregado a `/goal`:
 *   - `/goal --ultracode <obj>` hace que el prompt ITERATION reinyectado lleve la guía ULTRACODE
 *     (apoyarse en dynamic workflows), mientras que `/goal <obj>` plano NO.
 *   - el flag se quita del texto del objetivo (y del split de success-criteria),
 *     así nunca se filtra al objetivo que ve el modelo.
 *   - la postura se persiste en el snapshot goal-state para sobrevivir una recarga.
 *
 * Mecanismo: la extensión goal inyecta cada prompt de iteración vía `pi.sendUserMessage`. Generamos
 * el index.ts ACTUAL como ESM (mismo patrón self-bootstrapping que goal-verifier.test.mjs),
 * ejecutamos el comando REAL `/goal` contra pi/ctx mockeados, y capturamos sendUserMessage + los
 * snapshots goal-state persistidos. Afirmamos el texto OBSERVABLE del prompt y el snapshot, no una
 * copia del texto; si el wiring de la postura regresa, esta suite falla.
 *
 * Ejecución:
 *   node extensions/pandi-goal/tests/integration/goal-ultracode.test.mjs
 *
 * Código de salida 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = falló el harness.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildGoal() {
	return await buildExtension({
		name: "pi-goal-ultracode",
		src: path.join(REPO_ROOT, "extensions", "pandi-goal", "index.ts"),
		outName: "goal.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

// Mock pi: captura los prompts inyectados vía sendUserMessage y cada goal-state persistido.
function makePi() {
	const tools = new Map();
	const commands = new Map();
	const messages = []; // cada prompt de iteración/verificación inyectado, en orden
	const states = []; // cada snapshot goal-state agregado, en orden
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: () => {},
		appendEntry: (customType, data) => {
			if (customType === "goal-state") states.push(data);
		},
		sendUserMessage: (text) => messages.push(text),
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, messages, states };
}

function makeCtx() {
	return {
		mode: "tui",
		hasUI: true,
		cwd: REPO_ROOT,
		isIdle: () => true,
		isProjectTrusted: () => false,
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

function lastSnapshot(states) {
	return states.length ? states[states.length - 1] : undefined;
}

// El primer mensaje inyectado es el prompt de iteración 1 (fireGoal corre al inicio).
async function startGoalAndCapture(goalUrl, args) {
	const goalExtension = await loadDefault(goalUrl);
	const ctx = makeCtx();
	const built = makePi();
	goalExtension(built.pi);
	built.commands.get("goal").handler(args, ctx);
	return built;
}

// ===========================================================================
// ESCENARIO 1: `--ultracode` inyecta la guía ULTRACODE en el prompt de iteración.
// ===========================================================================
async function ultracodeInjectsGuidance(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "--ultracode ship the dashboard");
	const prompt = messages[0] ?? "";
	check("ultracode: an iteration prompt was injected", messages.length >= 1, `messages=${messages.length}`);
	check("ultracode: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("ultracode: guidance mentions dynamic workflows", /dynamic workflows/i.test(prompt));
	check(
		"ultracode: flag is stripped from the objective",
		/OBJETIVO \(textual\):\s*\nship the dashboard/.test(prompt) && !/--ultracode/.test(prompt),
		prompt.slice(0, 200),
	);
	check("ultracode: posture is persisted on the snapshot", lastSnapshot(states)?.ultracode === true);
}

// ===========================================================================
// ESCENARIO 2: el alias `--uc` funciona igual.
// ===========================================================================
async function ucAliasWorks(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "--uc refactor the parser");
	const prompt = messages[0] ?? "";
	check("alias --uc: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("alias --uc: posture is persisted", lastSnapshot(states)?.ultracode === true);
}

// ===========================================================================
// ESCENARIO 3: sin flag → sin texto ultracode, postura apagada (caracteriza el default).
// ===========================================================================
async function defaultHasNoUltracode(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "ship the dashboard");
	const prompt = messages[0] ?? "";
	check("default: an iteration prompt was injected", messages.length >= 1);
	check("default: no ULTRACODE wording without the flag", !/ULTRACODE:/.test(prompt));
	check(
		"default: posture is off (undefined/false) on the snapshot",
		!lastSnapshot(states)?.ultracode,
		`ultracode=${lastSnapshot(states)?.ultracode}`,
	);
}

// ===========================================================================
// ESCENARIO 4: el flag se quita incluso combinado con `-- <criteria>`; tanto el
// objetivo como los criterios sobreviven intactos.
// ===========================================================================
async function flagStrippedAlongsideCriteria(goalUrl) {
	const { messages, states } = await startGoalAndCapture(
		goalUrl,
		"ship the dashboard --ultracode -- the integration suite is green",
	);
	const prompt = messages[0] ?? "";
	check("criteria+flag: ULTRACODE guidance present", /ULTRACODE:/.test(prompt));
	check(
		"criteria+flag: objective is clean (no flag token)",
		/OBJETIVO \(textual\):\s*\nship the dashboard/.test(prompt) && !/--ultracode/.test(prompt),
	);
	check(
		"criteria+flag: success criteria survive",
		/the integration suite is green/.test(prompt) &&
			lastSnapshot(states)?.successCriteria === "the integration suite is green",
	);
}

async function main() {
	const { outDir, url } = await buildGoal();
	try {
		await ultracodeInjectsGuidance(url);
		await ucAliasWorks(url);
		await defaultHasNoUltracode(url);
		await flagStrippedAlongsideCriteria(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
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
