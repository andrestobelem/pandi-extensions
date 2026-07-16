#!/usr/bin/env node
/**
 * Test de integración de comportamiento duradero para extensions/pandi-rename/index.ts y sus
 * helpers puros (derive-name.ts, border-label.ts).
 *
 * Pinea el contrato público de /rename:
 * - cada nombre aplicado es un slug (minúsculas, separado por guiones, sin diacríticos)
 * - queda limitado a MAX_NAME_WORDS (4) palabras y nunca termina en una palabra conectora colgando
 *   (se recortan artículos/preposiciones/conjunciones finales para que se lea como un nombre)
 * - /rename <name> convierte a slug y fija el nombre de la sesión
 * - /rename sin argumento, sin UI, deriva un slug del mensaje de usuario más reciente
 * - /rename sin argumento nunca abre un diálogo: inventa un slug a partir del historial y lo aplica
 *   directamente, haya UI disponible o no
 * - historial vacío o solo whitespace hace respaldo a un nombre por defecto
 * - las fallas de setSessionName se reportan, no se lanzan
 * - el nombre actual se muestra como una etiqueta incrustada en el borde superior del editor,
 *   componiendo con una etiqueta existente alineada a la derecha (p. ej. "ultracode auto") y dejando las
 *   pistas de scroll intactas; la capa externa del editor delega todo el resto del comportamiento y no
 *   se apila entre reloads
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildRename() {
	return await buildExtension({
		name: "pi-rename-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-rename", "index.ts"),
		outName: "rename.mjs",
		stubs: { sdk: (dir) => sdkStub(dir, { customEditor: "render" }) },
	});
}

async function buildPureModule(file, outName, name) {
	return await buildExtension({
		name,
		src: path.join(REPO_ROOT, "extensions", "pandi-rename", file),
		outName,
		// spawn-summary.ts importa getPackageDir del SDK (búsqueda del nombre del binario host),
		// así que los bundles de módulos puros también necesitan el stub (inocuo para las entradas que no lo usan).
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
}

function userEntry(content) {
	return { type: "message", message: { role: "user", content } };
}

function assistantEntry(text) {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function violet(value) {
	return `\x1b[35m${value}\x1b[0m`;
}

function makePi({ throwOnSet = false, initialName } = {}) {
	let sessionName = initialName;
	const commands = new Map();
	const handlers = new Map();
	const pi = {
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		setSessionName: (name) => {
			if (throwOnSet) throw new Error("boom");
			sessionName = name;
		},
		getSessionName: () => sessionName,
	};
	return {
		pi,
		commands,
		handlers,
		get sessionName() {
			return sessionName;
		},
	};
}

function makeCtx({ hasUI = false, entries = [], inputResult, mode = "tui" } = {}) {
	const notes = [];
	const inputCalls = [];
	const ctx = {
		mode,
		hasUI,
		ui: {
			notify: (msg, type) => notes.push({ msg, type }),
			input: async (title, placeholder) => {
				inputCalls.push({ title, placeholder });
				return inputResult;
			},
		},
		sessionManager: { getEntries: () => entries },
	};
	ctx._notes = notes;
	ctx._inputCalls = inputCalls;
	return ctx;
}

// Un ctx que soporta la ruta de instalación de editor-component (refleja el cableado del host).
function makeEditorCtx(baseFactory) {
	let currentFactory = baseFactory;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			input: async () => undefined,
			getEditorComponent: () => currentFactory,
			setEditorComponent: (factory) => {
				currentFactory = factory;
			},
		},
		sessionManager: { getEntries: () => [] },
	};
	return { ctx, getFactory: () => currentFactory };
}

// Editor base mínimo que produce un borde superior violeta simple (o ya decorado).
function makeFakeEditor({ topLine } = {}) {
	const calls = { handleInput: [], invalidate: 0 };
	return {
		calls,
		borderColor: violet,
		focused: false,
		getText: () => "base-text",
		setText: () => {},
		handleInput: (data) => calls.handleInput.push(data),
		invalidate: () => {
			calls.invalidate += 1;
		},
		render: (width) => [topLine ? topLine(width) : violet("─".repeat(width)), "prompt", violet("─".repeat(width))],
	};
}

function borderWithLabel(label, width, color = violet) {
	const text = ` ${label} `;
	const right = 2;
	const left = width - text.length - right;
	return color("─".repeat(left) + text + "─".repeat(right));
}

async function fire(handlers, event, payload, ctx) {
	for (const handler of handlers.get(event) || []) await handler(payload, ctx);
}

async function scenarioSlugifyUnit(url) {
	const { slugify, deriveSessionName, DEFAULT_SESSION_NAME, MAX_NAME_WORDS } = await loadModule(url);

	check("MAX_NAME_WORDS is 4", MAX_NAME_WORDS === 4);
	check("slugify trims", slugify("  hi  ") === "hi");
	check("slugify lowercases and hyphenates words", slugify("Refactor Auth Module") === "refactor-auth-module");
	check("slugify drops punctuation", slugify('"Hello World!"') === "hello-world");
	check("slugify collapses non-alnum runs", slugify("a   b\tc--d") === "a-b-c-d");
	check("slugify strips diacritics", slugify("Café déjà vu") === "cafe-deja-vu");
	check("slugify empty stays empty", slugify("   ") === "");
	check("slugify non-ascii-only yields empty", slugify("日本語") === "");
	check("slugify is idempotent on a slug", slugify("refactor-auth") === "refactor-auth");
	check("slugify default caps at 4 words", slugify("alpha beta gamma delta epsilon") === "alpha-beta-gamma-delta");
	check(
		"slugify respects explicit maxWords",
		slugify("alpha beta gamma delta", { maxWords: 2, maxChars: 100 }) === "alpha-beta",
	);
	check(
		"slugify truncates on a word boundary within maxChars",
		(() => {
			const out = slugify("one two three four", { maxChars: 7, maxWords: 8 });
			return out === "one-two" && out.length <= 7;
		})(),
	);
	check(
		"slugify hard-truncates a single oversized word",
		slugify("supercalifragilistic", { maxChars: 5 }) === "super",
	);

	// Un nombre nunca debería terminar en un conector colgando (artículo/preposición/conjunción).
	check(
		"slugify drops a trailing connector word (es)",
		slugify("arreglar el bug de") === "arreglar-el-bug",
		slugify("arreglar el bug de"),
	);
	check(
		"slugify drops a trailing connector word (en)",
		slugify("cache invalidation strategy for", { maxWords: 8, maxChars: 100 }) === "cache-invalidation-strategy",
		slugify("cache invalidation strategy for", { maxWords: 8, maxChars: 100 }),
	);
	check(
		"slugify drops multiple trailing connectors",
		slugify("save the cache for the", { maxWords: 8, maxChars: 100 }) === "save-the-cache",
		slugify("save the cache for the", { maxWords: 8, maxChars: 100 }),
	);
	check(
		"slugify keeps a meaningful trailing word",
		slugify("refactor the auth module") === "refactor-the-auth-module",
		slugify("refactor the auth module"),
	);
	check(
		"slugify does not empty an all-connector slug",
		slugify("the of and", { maxWords: 8, maxChars: 100 }) === "the",
		slugify("the of and", { maxWords: 8, maxChars: 100 }),
	);
	check(
		"slugify trailing-connector trim respects the word cap first (stays a short name)",
		slugify("arreglar el bug de login cuando el usuario") === "arreglar-el-bug",
		slugify("arreglar el bug de login cuando el usuario"),
	);

	check(
		"deriveSessionName slugs the MOST RECENT user message (tracks current work)",
		deriveSessionName([assistantEntry("ignored"), userEntry("Fix the login bug"), userEntry("now do the cache")]) ===
			"now-do-the-cache",
	);
	check(
		"deriveSessionName walks back past a trailing /rename invocation and empty turns",
		deriveSessionName([
			userEntry("Initial task"),
			userEntry("Harden the loop gate"),
			userEntry("/rename"),
			userEntry("   "),
		]) === "harden-the-loop-gate",
		deriveSessionName([
			userEntry("Initial task"),
			userEntry("Harden the loop gate"),
			userEntry("/rename"),
			userEntry("   "),
		]),
	);
	check(
		"deriveSessionName joins text blocks and ignores images",
		deriveSessionName([
			userEntry([
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "Add Dark Mode" },
			]),
		]) === "add-dark-mode",
	);
	check(
		"deriveSessionName strips a leading slash-command token",
		deriveSessionName([userEntry("/explain the cache layer")]) === "the-cache-layer",
	);
	check(
		"deriveSessionName caps a long message at 4 words",
		deriveSessionName([userEntry("Investigate the flaky CI pipeline failures")]) === "investigate-the-flaky-ci",
	);
	check(
		"deriveSessionName does not leave a dangling connector after the word cap",
		deriveSessionName([userEntry("arreglar el bug de login cuando el usuario no tiene")]) === "arreglar-el-bug",
		deriveSessionName([userEntry("arreglar el bug de login cuando el usuario no tiene")]),
	);
	check(
		"deriveSessionName skips empty user messages (most recent non-empty wins)",
		deriveSessionName([userEntry("Real content here now"), userEntry("   ")]) === "real-content-here-now",
	);
	check("deriveSessionName falls back to default on empty history", deriveSessionName([]) === DEFAULT_SESSION_NAME);
	check("deriveSessionName tolerates non-array input", deriveSessionName(null) === DEFAULT_SESSION_NAME);
}

async function scenarioSummarizeUnit(url) {
	const { buildSummaryPrompt, slugFromSummaryOutput, summarizeSessionName } = await loadModule(url);

	const prompt = buildSummaryPrompt([
		userEntry("Set up the project"),
		assistantEntry("Created the scaffold"),
		userEntry("now harden the loop gate"),
	]);
	check("buildSummaryPrompt includes the most recent message", prompt.includes("now harden the loop gate"), prompt);
	check("buildSummaryPrompt asks for a short title", /t.tulo/i.test(prompt), prompt);
	check("buildSummaryPrompt is empty with no conversation", buildSummaryPrompt([]) === "");

	check(
		"slugFromSummaryOutput slugifies a quoted title",
		slugFromSummaryOutput('"Refactor Auth Module"') === "refactor-auth-module",
		slugFromSummaryOutput('"Refactor Auth Module"'),
	);
	check(
		"slugFromSummaryOutput takes the first line and drops markdown",
		slugFromSummaryOutput("# Loop Gate Hardening\nignored second line") === "loop-gate-hardening",
		slugFromSummaryOutput("# Loop Gate Hardening\nignored second line"),
	);
	check("slugFromSummaryOutput empty stays empty", slugFromSummaryOutput("   ") === "");

	const ok = await summarizeSessionName({
		entries: [userEntry("anything")],
		runSummary: async () => "Harden the loop gate",
	});
	check(
		"summarizeSessionName uses the LLM summary",
		ok.name === "harden-the-loop-gate" && ok.fellBack === false,
		JSON.stringify(ok),
	);

	const thrown = await summarizeSessionName({
		entries: [userEntry("Fix the cache layer")],
		runSummary: async () => {
			throw new Error("offline");
		},
	});
	check(
		"summarizeSessionName falls back to the deterministic name when the runner throws",
		thrown.name === "fix-the-cache-layer" && thrown.fellBack === true,
		JSON.stringify(thrown),
	);

	const empty = await summarizeSessionName({
		entries: [userEntry("Fix the cache layer")],
		runSummary: async () => "   ",
	});
	check(
		"summarizeSessionName falls back on empty model output",
		empty.name === "fix-the-cache-layer" && empty.fellBack === true,
		JSON.stringify(empty),
	);

	let called = false;
	const noHistory = await summarizeSessionName({
		entries: [],
		runSummary: async () => {
			called = true;
			return "should not run";
		},
	});
	check(
		"summarizeSessionName skips the LLM with no history (default name, no spawn)",
		noHistory.name === "session" && noHistory.fellBack === true && called === false,
		JSON.stringify(noHistory),
	);
}

async function scenarioSpawnArgsUnit(url) {
	const { buildPiSummaryArgs } = await loadModule(url);
	const withModel = buildPiSummaryArgs("THE PROMPT", { model: "anthropic/claude" });
	check(
		"buildPiSummaryArgs uses print mode and isolates the subprocess",
		withModel.includes("-p") &&
			withModel.includes("--no-extensions") &&
			withModel.includes("--no-skills") &&
			withModel.includes("--no-context-files"),
		JSON.stringify(withModel),
	);
	check(
		"buildPiSummaryArgs passes the model when given",
		withModel.includes("--model") && withModel.includes("anthropic/claude"),
	);
	check("buildPiSummaryArgs puts the prompt last", withModel[withModel.length - 1] === "THE PROMPT");
	const noModel = buildPiSummaryArgs("P", {});
	check(
		"buildPiSummaryArgs omits --model when not given",
		!noModel.includes("--model") && noModel[noModel.length - 1] === "P",
	);
}

async function scenarioSpawnTimeoutEscalates(url) {
	const { runPiSummary } = await loadModule(url);
	const outDir = path.dirname(fileURLToPath(url));
	const fakePi = path.join(outDir, "fake-pi-ignores-sigterm.mjs");
	await fs.writeFile(
		fakePi,
		"#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.stderr.write('ignored SIGTERM\\n'));\nsetInterval(() => {}, 1_000);\n",
		{ mode: 0o755 },
	);
	const previousCommand = process.env.PI_RENAME_PI_COMMAND;
	try {
		process.env.PI_RENAME_PI_COMMAND = fakePi;
		const startedAt = Date.now();
		let failureMessage = "";
		try {
			await runPiSummary("timeout test", { timeoutMs: 1_000 });
		} catch (error) {
			failureMessage = error instanceof Error ? error.message : String(error);
		}
		const elapsedMs = Date.now() - startedAt;
		check("runPiSummary rejects when the child exceeds its timeout", failureMessage.length > 0);
		check("runPiSummary sends SIGTERM before escalating", failureMessage.includes("ignored SIGTERM"), failureMessage);
		check(
			"runPiSummary escalates SIGTERM to SIGKILL for an uncooperative child",
			elapsedMs < 5_000,
			`${elapsedMs}ms`,
		);
	} finally {
		if (previousCommand === undefined) delete process.env.PI_RENAME_PI_COMMAND;
		else process.env.PI_RENAME_PI_COMMAND = previousCommand;
		await fs.rm(fakePi, { force: true });
	}
}

async function scenarioNoArgSummary(url) {
	const renameExtension = await loadDefault(url);
	const outDir = path.dirname(fileURLToPath(url));

	// Éxito: un `pi` falso imprime un título; la ruta sin argumento lo convierte en slug.
	const fakePiOk = path.join(outDir, "fake-pi-ok.mjs");
	await fs.writeFile(fakePiOk, "#!/usr/bin/env node\nprocess.stdout.write('Harden The Loop Gate\\n');\n", {
		mode: 0o755,
	});
	const prev = process.env.PI_RENAME_PI_COMMAND;
	try {
		process.env.PI_RENAME_PI_COMMAND = fakePiOk;
		const h = makePi();
		renameExtension(h.pi);
		const ctx = makeCtx({ hasUI: true, entries: [userEntry("set up project"), userEntry("work on the gate")] });
		await h.commands.get("rename").handler("", ctx);
		check("/rename no-arg applies the LLM-summarized slug", h.sessionName === "harden-the-loop-gate", h.sessionName);
	} finally {
		if (prev === undefined) delete process.env.PI_RENAME_PI_COMMAND;
		else process.env.PI_RENAME_PI_COMMAND = prev;
		await fs.rm(fakePiOk, { force: true });
	}

	// Falla: el spawn da error -> respaldo determinístico desde el mensaje más reciente.
	const prev2 = process.env.PI_RENAME_PI_COMMAND;
	try {
		process.env.PI_RENAME_PI_COMMAND = path.join(outDir, "definitely-not-a-real-pi-binary");
		const h = makePi();
		renameExtension(h.pi);
		const ctx = makeCtx({
			hasUI: false,
			entries: [userEntry("set up project"), userEntry("Investigate flaky CI pipeline")],
		});
		await h.commands.get("rename").handler("", ctx);
		check(
			"/rename no-arg falls back to the deterministic name when the LLM spawn fails",
			h.sessionName === "investigate-flaky-ci-pipeline",
			h.sessionName,
		);
	} finally {
		if (prev2 === undefined) delete process.env.PI_RENAME_PI_COMMAND;
		else process.env.PI_RENAME_PI_COMMAND = prev2;
	}
}

async function scenarioBorderLabelUnit(url) {
	const { composeTopBorder } = await loadModule(url);

	const plain80 = "─".repeat(80);
	const named = composeTopBorder(plain80, 80, "my-task");
	check("composeTopBorder adds the label on a plain border", named?.includes("my-task") === true, named);
	check("composeTopBorder keeps the border glyphs", named?.includes("─") === true, named);
	check("composeTopBorder keeps the line width", named?.length === 80, String(named?.length));
	check("composeTopBorder does not add a cardinal", named?.includes("⌗") === false, named);

	const pillNamed = composeTopBorder(plain80, 80, "my-task", { color: (s) => s, labelColor: (s) => `[${s}]` });
	check(
		"composeTopBorder styles the name with labelColor (pill)",
		pillNamed?.includes("[ my-task ]") === true,
		pillNamed,
	);

	const withUltra = composeTopBorder(
		borderWithLabel("ultracode auto", 80, (s) => s),
		80,
		"my-task",
		{
			color: (s) => s,
		},
	);
	check(
		"composeTopBorder composes with an existing right-aligned label",
		withUltra?.includes("my-task") === true && withUltra?.includes("ultracode auto") === true,
		withUltra,
	);
	check(
		"composeTopBorder puts the existing label first and the name last (inverted order)",
		withUltra != null && withUltra.indexOf("ultracode auto") < withUltra.indexOf("my-task"),
		withUltra,
	);

	const scrolled = `─── ↑ 3 more ${"─".repeat(80 - 13)}`;
	check(
		"composeTopBorder leaves a scroll hint untouched (returns null)",
		composeTopBorder(scrolled, 80, "x") === null,
	);
	check("composeTopBorder bails on a non-border line", composeTopBorder("hello world", 80, "x") === null);
	check("composeTopBorder bails when there is no room", composeTopBorder("─".repeat(6), 6, "a long label") === null);
	check("composeTopBorder bails with an empty label", composeTopBorder(plain80, 80, "") === null);
}

async function scenarioExplicitName(url) {
	const renameExtension = await loadDefault(url);
	const harness = makePi();
	renameExtension(harness.pi);
	const command = harness.commands.get("rename");
	check("/rename command registered", !!command);
	check("/rename has a description", typeof command.description === "string" && command.description.length > 0);

	const ctx = makeCtx({ hasUI: true });
	await command.handler("Refactor Auth", ctx);
	check("/rename <name> sets a slug session name", harness.sessionName === "refactor-auth", harness.sessionName);
	check(
		"/rename <name> notifies success with the slug",
		ctx._notes.some((n) => n.type === "info" && /renombrada a "refactor-auth"/.test(n.msg)),
		JSON.stringify(ctx._notes),
	);
	check("/rename <name> does not open the input dialog", ctx._inputCalls.length === 0);

	await command.handler('  "  Hello   World!  "  ', ctx);
	check("/rename slugifies quotes and punctuation", harness.sessionName === "hello-world", harness.sessionName);

	await command.handler("one two three four five", ctx);
	check("/rename caps an explicit name at 4 words", harness.sessionName === "one-two-three-four", harness.sessionName);
}

async function scenarioNoArgHeadless(url) {
	const renameExtension = await loadDefault(url);
	// Forzá que falle el spawn del LLM para ejercitar el respaldo DETERMINISTA (último mensaje).
	const prev = process.env.PI_RENAME_PI_COMMAND;
	process.env.PI_RENAME_PI_COMMAND = "definitely-not-a-real-pi-binary";
	try {
		const harness = makePi();
		renameExtension(harness.pi);
		const command = harness.commands.get("rename");

		const ctx = makeCtx({
			hasUI: false,
			entries: [userEntry("Set up the project"), userEntry("Investigate flaky CI pipeline")],
		});
		await command.handler("", ctx);
		check(
			"/rename no-arg headless fallback derives a slug from the most recent user message",
			harness.sessionName === "investigate-flaky-ci-pipeline",
			harness.sessionName,
		);
		check("/rename no-arg headless does not open input dialog", ctx._inputCalls.length === 0);

		// Un argumento con solo whitespace se trata como sin argumento.
		const harness2 = makePi();
		renameExtension(harness2.pi);
		const command2 = harness2.commands.get("rename");
		const ctx2 = makeCtx({ hasUI: false, entries: [userEntry("Spaces only arg path")] });
		await command2.handler("    ", ctx2);
		check(
			"/rename whitespace-only arg falls to the no-arg derive path",
			harness2.sessionName === "spaces-only-arg-path",
			harness2.sessionName,
		);
	} finally {
		if (prev === undefined) delete process.env.PI_RENAME_PI_COMMAND;
		else process.env.PI_RENAME_PI_COMMAND = prev;
	}
}

async function scenarioNoArgUI(url) {
	const renameExtension = await loadDefault(url);
	const command = (h) => h.commands.get("rename");
	const entries = [userEntry("Build the rename extension")];

	// Incluso con UI disponible, la ruta sin argumento inventa el nombre y NUNCA abre un diálogo de entrada.
	// Forzá que falle el spawn del LLM para que el nombre salga del respaldo determinístico.
	const prev = process.env.PI_RENAME_PI_COMMAND;
	process.env.PI_RENAME_PI_COMMAND = "definitely-not-a-real-pi-binary";
	try {
		const h1 = makePi();
		renameExtension(h1.pi);
		const ctx1 = makeCtx({ hasUI: true, entries, inputResult: "Should Be Ignored" });
		await command(h1).handler("", ctx1);
		check("/rename no-arg with UI invents the name", h1.sessionName === "build-the-rename-extension", h1.sessionName);
		check(
			"/rename no-arg with UI does NOT open an input dialog",
			ctx1._inputCalls.length === 0,
			JSON.stringify(ctx1._inputCalls),
		);
	} finally {
		if (prev === undefined) delete process.env.PI_RENAME_PI_COMMAND;
		else process.env.PI_RENAME_PI_COMMAND = prev;
	}
}

async function scenarioBorderEditor(url) {
	const renameExtension = await loadDefault(url);

	// El nombre se muestra en el borde superior una vez instalado.
	const h1 = makePi({ initialName: "my-task" });
	renameExtension(h1.pi);
	const fake1 = makeFakeEditor();
	const e1 = makeEditorCtx(() => fake1);
	await fire(h1.handlers, "session_start", {}, e1.ctx);
	const factory1 = e1.getFactory();
	check("session_start installs an editor factory", typeof factory1 === "function");
	const wrapped1 = factory1({ requestRender() {} }, {}, {});
	const raw1 = wrapped1.render(80)[0];
	const top1 = stripAnsi(raw1);
	check("top border shows the session name", top1.includes("my-task"), top1);
	check("top border keeps border glyphs", top1.includes("─"), top1);
	check("top border drops the cardinal", !top1.includes("⌗"), top1);
	check("name renders as an inverted pill (reverse video)", raw1.includes("\x1b[7m"), JSON.stringify(raw1));
	check("wrapped editor carries the reuse marker", wrapped1.__piRenameNameBorderEditor === true);

	// Delega el comportamiento fuera de render al editor base.
	check("wrapped editor delegates getText", wrapped1.getText() === "base-text");
	wrapped1.handleInput("x");
	check("wrapped editor delegates handleInput", fake1.calls.handleInput.includes("x"));

	// Compone con una etiqueta existente alineada a la derecha (ultracode auto).
	const h2 = makePi({ initialName: "my-task" });
	renameExtension(h2.pi);
	const fake2 = makeFakeEditor({ topLine: (w) => borderWithLabel("ultracode auto", w) });
	const e2 = makeEditorCtx(() => fake2);
	await fire(h2.handlers, "session_start", {}, e2.ctx);
	const top2 = stripAnsi(
		e2
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check(
		"border composes name with ultracode label",
		top2.includes("my-task") && top2.indexOf("ultracode auto") < top2.indexOf("my-task"),
		top2,
	);

	// Deja intacta una pista de scroll.
	const h3 = makePi({ initialName: "my-task" });
	renameExtension(h3.pi);
	const fake3 = makeFakeEditor({ topLine: (w) => violet(`─── ↑ 3 more ${"─".repeat(w - 13)}`) });
	const e3 = makeEditorCtx(() => fake3);
	await fire(h3.handlers, "session_start", {}, e3.ctx);
	const top3 = stripAnsi(
		e3
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check("scroll hint left untouched (no name injected)", top3.includes("↑ 3 more") && !top3.includes("my-task"), top3);

	// Sesión sin nombre: el borde pasa sin cambios.
	const h4 = makePi();
	renameExtension(h4.pi);
	const fake4 = makeFakeEditor();
	const e4 = makeEditorCtx(() => fake4);
	await fire(h4.handlers, "session_start", {}, e4.ctx);
	const top4 = stripAnsi(
		e4
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check("unnamed session leaves the border plain", !top4.includes("my-task") && /^─+$/.test(top4), top4);

	// Volver a cargar session_start no debe apilar otra capa.
	const h5 = makePi({ initialName: "my-task" });
	renameExtension(h5.pi);
	const fake5 = makeFakeEditor();
	const e5 = makeEditorCtx(() => fake5);
	await fire(h5.handlers, "session_start", {}, e5.ctx);
	await fire(h5.handlers, "session_start", {}, e5.ctx);
	const top5 = stripAnsi(
		e5
			.getFactory()({ requestRender() {} }, {}, {})
			.render(80)[0],
	);
	check("reload does not double-wrap the label", (top5.match(/my-task/g) || []).length === 1, top5);
}

async function scenarioFallbacksAndErrors(url) {
	const renameExtension = await loadDefault(url);
	const command = (h) => h.commands.get("rename");

	// Historial vacío sin UI -> nombre por defecto.
	const h1 = makePi();
	renameExtension(h1.pi);
	const ctx1 = makeCtx({ hasUI: false, entries: [] });
	await command(h1).handler("", ctx1);
	check("/rename empty history falls back to default", h1.sessionName === "session", h1.sessionName);

	// setSessionName lanza -> se reporta como error, sin crash.
	const h2 = makePi({ throwOnSet: true });
	renameExtension(h2.pi);
	const ctx2 = makeCtx({ hasUI: true });
	let threw = false;
	try {
		await command(h2).handler("anything", ctx2);
	} catch {
		threw = true;
	}
	check("/rename does not crash when setSessionName throws", !threw);
	check(
		"/rename reports a setSessionName failure",
		ctx2._notes.some((n) => n.type === "error" && /no se pudo renombrar/i.test(n.msg)),
		JSON.stringify(ctx2._notes),
	);
}

async function main() {
	const derive = await buildPureModule("derive-name.ts", "derive.mjs", "pi-rename-derive");
	try {
		await scenarioSlugifyUnit(derive.url);
	} finally {
		await fs.rm(derive.outDir, { recursive: true, force: true });
	}

	const border = await buildPureModule("border-label.ts", "border.mjs", "pi-rename-border");
	try {
		await scenarioBorderLabelUnit(border.url);
	} finally {
		await fs.rm(border.outDir, { recursive: true, force: true });
	}

	const summarize = await buildPureModule("summarize-name.ts", "summarize.mjs", "pi-rename-summarize");
	try {
		await scenarioSummarizeUnit(summarize.url);
	} finally {
		await fs.rm(summarize.outDir, { recursive: true, force: true });
	}

	const spawnMod = await buildPureModule("spawn-summary.ts", "spawn-summary.mjs", "pi-rename-spawn");
	try {
		await scenarioSpawnArgsUnit(spawnMod.url);
		await scenarioSpawnTimeoutEscalates(spawnMod.url);
	} finally {
		await fs.rm(spawnMod.outDir, { recursive: true, force: true });
	}

	const hintMod = await buildPureModule("exit-name-hint.ts", "exit-name-hint.mjs", "pi-rename-exit-hint");
	try {
		await scenarioExitNameHint(hintMod.url);
	} finally {
		await fs.rm(hintMod.outDir, { recursive: true, force: true });
	}

	const ext = await buildRename();
	try {
		await scenarioExplicitName(ext.url);
		await scenarioNoArgHeadless(ext.url);
		await scenarioNoArgUI(ext.url);
		await scenarioNoArgSummary(ext.url);
		await scenarioBorderEditor(ext.url);
		await scenarioFallbacksAndErrors(ext.url);
	} finally {
		await fs.rm(ext.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

// exit-name-hint.ts: la línea tenue "Nombre de sesión: <slug>" impresa debajo de la
// pista de reanudación al salir solo con UUID de pi core (stopgap para earendil-works/pi#6296).
async function scenarioExitNameHint(url) {
	const { formatExitNameHint, installExitNameHint, EXIT_HINT_KEY } = await loadModule(url);

	const line = stripAnsi(formatExitNameHint("docs-html-mirror-sync"));
	check("exit hint line carries the localized label", line.includes("Nombre de sesión:"));
	check("exit hint line carries the name", line.includes("docs-html-mirror-sync"));
	check("exit hint line points at resume-by-name (pi -r)", line.includes("reanudar por nombre: pi -r"));
	check("exit hint line is newline-terminated", line.endsWith("\n"));

	function makeIo({ tty = true } = {}) {
		const hooks = [];
		const writes = [];
		return {
			io: { isTTY: () => tty, onExit: (hook) => hooks.push(hook), write: (text) => writes.push(text) },
			hooks,
			writes,
		};
	}

	// Sesión con nombre: el hook escribe exactamente la línea formateada.
	{
		const { io, hooks, writes } = makeIo();
		const setName = installExitNameHint(io, {});
		check("install returns a setter on a TTY", typeof setName === "function");
		check("install registers exactly one exit hook", hooks.length === 1);
		setName("mi-sesion");
		for (const hook of hooks) hook();
		check("exit hook prints the current name", writes.length === 1 && stripAnsi(writes[0]).includes("mi-sesion"));
	}

	// Sesión sin nombre: salida silenciosa (sin línea extra debajo de la pista de core).
	{
		const { io, hooks, writes } = makeIo();
		installExitNameHint(io, {});
		for (const hook of hooks) hook();
		check("exit hook writes nothing when the session is unnamed", writes.length === 0);
	}

	// Nombre limpiado: setter(undefined) vuelve a suprimir la línea.
	{
		const { io, hooks, writes } = makeIo();
		const setName = installExitNameHint(io, {});
		setName("algo");
		setName(undefined);
		for (const hook of hooks) hook();
		check("exit hook respects a cleared name", writes.length === 0);
	}

	// No es TTY (pipes, modo print): nunca instala, nunca escribe.
	{
		const { io, hooks } = makeIo({ tty: false });
		const setName = installExitNameHint(io, {});
		check("install returns undefined off-TTY", setName === undefined);
		check("no exit hook is registered off-TTY", hooks.length === 0);
	}

	// Semántica de reload: una segunda instalación sobre el mismo registry reutiliza el holder
	// (un hook, una línea) y su setter actualiza el nombre que lee el hook original.
	{
		const { io, hooks, writes } = makeIo();
		const registry = {};
		installExitNameHint(io, registry);
		const setName2 = installExitNameHint(io, registry);
		check("reload does not stack a second exit hook", hooks.length === 1);
		check("reload still returns a working setter", typeof setName2 === "function");
		setName2("post-reload");
		for (const hook of hooks) hook();
		check(
			"post-reload setter feeds the original hook",
			writes.length === 1 && stripAnsi(writes[0]).includes("post-reload"),
		);
		check("registry holder registered under the shared symbol", EXIT_HINT_KEY in registry);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
