/**
 * Tests de integracion para la compuerta de seguridad de autopilot y el clamp de loop_schedule en
 * extensions/pandi-loop/index.ts.
 *
 * Estos no son tests completos de integracion del proceso Pi: empaquetan la extension actual en
 * un directorio temp, la cargan con ExtensionAPI/ctx mockeados y verifican el comportamiento
 * observable de la compuerta.
 *
 * Ejecutarlo:
 *   node extensions/pandi-loop/tests/integration/loop-safety.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadDefault, makeBuildDir, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/<extension>/tests/integration/ -> el repo root está cuatro niveles arriba.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// cwd de proyecto mockeado por default. main() apunta esto al dir temp de build para que las
// escrituras sidecar del loop nunca ensucien el .pi/loops del repo real durante los tests.
let TEST_PROJECT_ROOT = REPO_ROOT;

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Construye las extensiones actuales a ESM en un dir temp y devuelve las import URLs.
// ---------------------------------------------------------------------------
async function buildExtensions(names) {
	// Las rutas de gate ejercitadas solo necesitan typebox para la declaración del tool-schema y los
	// símbolos del SDK para resolver el state-dir — nunca validación. Un outDir/stubs compartido mantiene
	// getAgentDir consistente entre las extensiones bundleadas.
	const { outDir, aliases } = await makeBuildDir("pi-safety-integration", {
		typebox: true,
		sdk: (dir) => sdkStub(dir),
	});
	const urls = {};
	for (const name of names) {
		const packageDir = name === "pandi" || name.startsWith("pandi-") ? name : `pandi-${name}`;
		urls[name] = await bundle({
			src: path.join(REPO_ROOT, "extensions", packageDir, "index.ts"),
			outDir,
			outName: `${name}.mjs`,
			aliases,
		});
	}
	return { outDir, urls };
}

// Un módulo mantiene un singleton (activeLoops / activePlans). Cargá una instancia FRESCA por
// escenario vía una query cache-busting para que los escenarios nunca filtren estado entre sí.

// ---------------------------------------------------------------------------
// Mock de pi + ctx (la forma espeja la superficie de ExtensionAPI / ExtensionContext que
// las extensiones usan realmente, aprendida de los handlers reales).
// ---------------------------------------------------------------------------
function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content, options) => sentMessages.push({ content, options }),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, handlers, entries, sentMessages };
}

function makeCtx({ mode = "tui", hasUI = true, confirmResult = true, cwd = TEST_PROJECT_ROOT, entries = [] } = {}) {
	const ctx = {
		mode,
		hasUI,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: () => {},
			setStatus: () => {},
			confirm: async () => ctx._confirmResult,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => entries },
	};
	ctx._confirmResult = confirmResult;
	return ctx;
}

function toolCallEvent(toolName, input = {}) {
	return {
		type: "tool_call",
		toolCallId: `tc-${Math.random().toString(16).slice(2)}`,
		toolName,
		input,
	};
}

// Corre cada handler registrado de tool_call; gana el primer bloqueo (refleja el engine).
async function runGate(handlers, ctx, event) {
	for (const h of handlers.get("tool_call") || []) {
		const res = await h(event, ctx);
		if (res?.block) return res;
	}
	return undefined;
}

// ===========================================================================
// ESCENARIO 3: compuerta destructiva de autopilot de loop.ts. Solo está armada mientras un loop está en
// autopilot (es decir, el turno fue disparado por un wake, no por un humano). Iniciar un loop
// en modo tui dispara el primer wake sincrónicamente, seteando autopilot=true.
// ===========================================================================
async function loopAutopilotGate(loopUrl) {
	const loopExtension = await loadDefault(loopUrl);
	const { pi, commands, handlers } = makePi();
	loopExtension(pi);
	const cwd = TEST_PROJECT_ROOT;
	const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: false, cwd });

	// Antes de cualquier loop: la compuerta está inerte (sin autopilot activo) -> comando destructivo permitido.
	const preRm = await runGate(handlers, ctx, toolCallEvent("bash", { command: "rm -rf /tmp/x" }));
	check("loop: rm -rf ALLOWED before any loop (no autopilot)", preRm === undefined);

	// Inicia un loop. fireWake() corre sincrónicamente y setea autopilot=true en este loop.
	await commands.get("loop").handler("keep the build green", ctx);

	// Mientras autopilot está activo (confirmResult=false => deny), bash destructivo queda BLOQUEADO.
	for (const cmd of [
		"rm -rf build",
		"rm -fr build",
		"git push --force origin main",
		"git push -f",
		"git reset --hard HEAD~1",
		"git clean -fd",
		"dd if=/dev/zero of=/dev/sda",
		"mkfs.ext4 /dev/sdb",
		"terraform apply -auto-approve",
		"kubectl delete pod x",
		// rm recursivo sin -f, y eliminaciones con find/truncate/shred.
		"rm -r build",
		"find . -name '*.sqlite' -delete",
		"find . -type f -exec rm {} +",
		"truncate -s 0 important.db",
		"shred -u secret.key",
		// Redirecciones de shell / tee que escriben FUERA del proyecto (paridad con write/edit).
		"echo x > /etc/cron.d/pwn",
		"echo x | tee /etc/hosts",
		// L1: tilde (~) y vars de shell sin expandir ($HOME/${HOME}) resuelven FUERA del
		// proyecto en tiempo de expansión de shell; nuestra matemática de paths nunca las expande,
		// así que deben tratarse como escrituras fuera del proyecto.
		"echo pwn >> ~/.bashrc",
		"echo pwn > $HOME/.profile",
		// Un template literal + `\${` escapado conserva el texto literal ${HOME} (mismo valor)
		// sin disparar noTemplateCurlyInString en un string regular.
		`echo pwn > \${HOME}/.evil`,
		"echo pwn | tee ~/.ssh/authorized_keys",
		// L2: un `cd`/`pushd` a un dir que no podemos probar dentro del proyecto vuelve inseguro un target
		// de redirección RELATIVO (ya no resuelve debajo de ctx.cwd).
		"cd /etc && echo x > hosts",
		"cd /tmp && echo x | tee secret.key",
		"cd ~ && echo x > .bashrc",
		"cd && echo x > .bashrc",
		"cd .. && echo x > escaped.txt",
		// HARDENING: evasiones de la intención EXISTING de la compuerta que antes se colaban.
		// git force-push via un refspec `+` (sin flag --force/-f).
		"git push origin +master",
		"git push origin +refs/heads/main",
		// Operador clobber `>|` y redirección combinada `&>` escribiendo FUERA del proyecto.
		"echo x >| /etc/cron.d/pwn",
		"echo x &> /etc/hosts",
		"echo x &>> /etc/hosts",
		// Target de redirección que es una sustitución de comando: no se puede probar dentro del proyecto, así que
		// se trata como inseguro (consistente con el tratamiento existente de $VAR/${VAR}).
		"echo x > $(getconf DARWIN_USER_DIR)/p",
		// Destrucción de history / stash de git (irreversible) - misma familia que las compuertas git existentes.
		"git filter-branch --force --all",
		"git stash clear",
		"git stash drop",
		// RONDA 2 (hallazgos de adversarial-workflow, cada uno verificado vs la compuerta real):
		// Redirección combinada `>&file` (el espejo con `>` primero de `&>` ya cubierto por la compuerta).
		"printf x >& ~/.ssh/authorized_keys",
		// tee multi-target: se revisa cada target, no solo el primero.
		"echo x | tee build/out.log /etc/cron.d/payload",
		"echo x | tee -a logs/x /root/.bashrc",
		// pushes remotos destructivos que no llevan NINGÚN flag force (delete / mirror / prune / :ref).
		"git push origin --delete production",
		"git push origin :production",
		"git push --mirror origin",
		// line-continuation parte un comando entre líneas, así los patrones [^\n]* no ven los flags.
		"rm \\\n  -rf .git node_modules",
		// Variantes SQL DROP mas alla de table/database/schema.
		"psql -c 'DROP OWNED BY app CASCADE;'",
		"psql -c 'DROP TABLESPACE fast;'",
		// Alias de formato de filesystem de mkfs.
		"mke2fs -F -t ext4 /dev/sdb1",
		"mkswap /dev/sdb2",
		// find -exec con un rm calificado por path (/bin/rm) en vez de rm desnudo.
		"find . -type f -exec /bin/rm {} +",
		// git checkout --force / -f descarta trabajo sin commit como reset --hard.
		"git checkout -f origin/main",
		// Destruccion / rollback de release helm.
		"helm delete prod-release --namespace prod",
		"helm rollback prod 3",
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`loop(autopilot): BLOCKS bash "${cmd}"`, !!r && r.block === true, r ? "" : "not blocked");
	}

	// bash no destructivo se permite incluso bajo autopilot. Las redirecciones dentro del proyecto y
	// fd-dups (2>&1) NO deben confundirse con escrituras fuera del proyecto.
	for (const cmd of [
		"npm test",
		"git status",
		"ls -la",
		"rm foo.txt",
		"git commit -m x",
		"echo hi > notes.txt",
		"node build.js > out.log 2>&1",
		"cmd 2>&1",
		"echo ok > /dev/null",
		// Guardas de falsos positivos L2: un cd dentro del proyecto, un substring "cd" dentro de un path,
		// y /dev/null después de un cd fuera del proyecto deben seguir PERMITIDOS.
		"cd build && echo x > out.log",
		"cat src/cd/file > out.txt",
		"cd /etc && echo ok > /dev/null",
		// Guardas de falsos positivos HARDENING: un push ordinario (non-force), un `&>` dentro del proyecto
		// y clobber `>|`, y un `git stash` (sin clear/drop) deben seguir PERMITIDOS.
		"git push origin main",
		"node build.js &> out.log",
		"echo x >| local.txt",
		"git stash",
		"git stash pop",
		// Guardas de falsos positivos RONDA 2: fd-dups y combined-redirects/tee que siguen dentro del proyecto,
		// más un checkout y restore ordinarios (non-force), deben permanecer PERMITIDOS.
		"echo err >&2",
		"node build.js > out.log 2>&1",
		"echo x | tee build/a.log build/b.log",
		"git checkout feature-branch",
		"git restore src/x.ts",
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`loop(autopilot): ALLOWS bash "${cmd}"`, r === undefined, r ? r.reason : "");
	}

	// write/edit: bloqueado solo cuando el path escapa de la raiz del proyecto.
	const outside = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "/etc/passwd", content: "x" }));
	check("loop(autopilot): BLOCKS write to /etc/passwd (outside project)", !!outside && outside.block === true);
	const traversal = await runGate(handlers, ctx, toolCallEvent("edit", { file_path: "../../secret" }));
	check("loop(autopilot): BLOCKS edit via .. traversal", !!traversal && traversal.block === true);
	const inside = await runGate(
		handlers,
		ctx,
		toolCallEvent("write", { file_path: path.join(cwd, "fixtures/x.txt"), content: "x" }),
	);
	check("loop(autopilot): ALLOWS write inside project", inside === undefined, inside ? inside.reason : "");
	const relInside = await runGate(
		handlers,
		ctx,
		toolCallEvent("write", { file_path: "fixtures/x.txt", content: "x" }),
	);
	check(
		"loop(autopilot): ALLOWS relative write inside project",
		relInside === undefined,
		relInside ? relInside.reason : "",
	);
}

// ===========================================================================
// ESCENARIO 4: CLAMP del delay de loop_schedule a [60, 3600] (la única defensa -
// nunca se confía en el modelo). Ejecuta directamente el execute() del tool registrado.
// ===========================================================================
async function loopScheduleClamp(loopUrl) {
	const loopExtension = await loadDefault(loopUrl);
	const { pi, commands, tools } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	// Necesita un loop DYNAMIC en ejecución para que loop_schedule actúe.
	await commands.get("loop").handler("a dynamic task", ctx);
	const sched = tools.get("loop_schedule");
	check("loop_schedule tool registered", !!sched);

	async function delayFor(raw) {
		const res = await sched.execute("tc", { delaySeconds: raw, reason: "test clamp" }, undefined, undefined, ctx);
		return res.details ? res.details.delaySeconds : undefined;
	}

	check("loop_schedule: 5 clamps up to 60", (await delayFor(5)) === 60);
	check("loop_schedule: 30 clamps up to 60", (await delayFor(30)) === 60);
	check("loop_schedule: 1800 passes through", (await delayFor(1800)) === 1800);
	check("loop_schedule: 99999 clamps down to 3600", (await delayFor(99999)) === 3600);
	check("loop_schedule: 60 (lower bound) stays 60", (await delayFor(60)) === 60);
	check("loop_schedule: 3600 (upper bound) stays 3600", (await delayFor(3600)) === 3600);
	check("loop_schedule: NaN falls back to safety net (1500)", (await delayFor(Number.NaN)) === 1500);
}

// ===========================================================================
async function main() {
	const { outDir, urls } = await buildExtensions(["loop"]);
	TEST_PROJECT_ROOT = path.join(outDir, "project");
	await fs.mkdir(TEST_PROJECT_ROOT, { recursive: true });
	try {
		await loopAutopilotGate(urls.loop);
		await loopScheduleClamp(urls.loop);
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
	// Los loops iniciados dejan timers setTimeout vivos en los tests de loop; salir explícitamente para que
	// el runner de comportamiento nunca quede colgado tras una corrida en verde.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
