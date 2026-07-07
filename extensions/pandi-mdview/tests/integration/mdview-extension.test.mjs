#!/usr/bin/env node
/**
 * Test de integración conductual durable para extensions/pandi-mdview/index.ts.
 *
 * Fija el contrato público de /mdview:
 * - el comando lo registra la extensión
 * - una ruta relativa a un archivo Markdown abre un componente TUI personalizado
 * - las rutas entre comillas con espacios se resuelven relativas a ctx.cwd
 * - q cierra el visor enfocado
 * - argumentos/archivos faltantes informan warnings/errors de UI acotados en vez de lanzar
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildMdview() {
	return await buildExtension({
		name: "pi-mdview-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-mdview", "index.ts"),
		outName: "mdview.mjs",
		npx: "--no-install",
	});
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			// La extensión también registra una TOOL `view_markdown` invocable por el modelo; esta
			// suite solo ejercita el COMMAND /mdview, así que captura tools sin afirmar nada.
			registerTool: (tool) => tools.set(tool.name, tool),
		},
		commands,
		tools,
	};
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeTheme() {
	const id = (_color, text) => text;
	return {
		fg: id,
		bg: id,
		bold: (text) => text,
		italic: (text) => text,
		underline: (text) => text,
		inverse: (text) => text,
		strikethrough: (text) => text,
	};
}

function makeCtx({ cwd, mode = "tui", rows = 12, width = 80, hasUI = mode !== "print" } = {}) {
	const notes = [];
	const customCalls = [];
	const theme = makeTheme();
	const tui = {
		terminal: { columns: width, rows },
		renderRequests: 0,
		requestRender() {
			this.renderRequests += 1;
		},
	};
	const ctx = {
		mode,
		hasUI,
		cwd,
		ui: {
			theme,
			notify: (msg, type) => notes.push({ msg, type }),
			custom: async (factory) => {
				const call = { component: undefined, firstRender: undefined };
				customCalls.push(call);
				let closed = false;
				let closeValue;
				const component = await factory(tui, theme, {}, (value) => {
					closed = true;
					closeValue = value;
				});
				call.component = component;
				call.firstRender = component.render(width);
				component.handleInput?.("q");
				if (!closed) throw new Error("mdview component did not close on q");
				return closeValue;
			},
		},
	};
	ctx._notes = notes;
	ctx._customCalls = customCalls;
	ctx._tui = tui;
	return ctx;
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, commands } = makePi();
	extension(pi);
	return { commands };
}

async function scenarioRegisters(url) {
	const { commands } = await loadExtension(url);
	check("/mdview registrado", commands.has("mdview"));
	check("/mdview tiene descripción", /Markdown/i.test(commands.get("mdview")?.description || ""));
}

async function scenarioPackageDeclaresRuntimePeers() {
	const source = await fs.readFile(path.join(REPO_ROOT, "extensions", "pandi-mdview", "index.ts"), "utf8");
	const pkg = JSON.parse(
		await fs.readFile(path.join(REPO_ROOT, "extensions", "pandi-mdview", "package.json"), "utf8"),
	);
	check(
		"package: declara la peer dependency de typebox usada por el import de esquema en runtime",
		!/from "typebox"/.test(source) || typeof pkg.peerDependencies?.typebox === "string",
		JSON.stringify(pkg.peerDependencies),
	);
}

async function scenarioRendersRelativePath(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-project-"));
	await fs.writeFile(path.join(cwd, "README.md"), "# Hello Markdown\n\nBody text\n", "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, rows: 10, width: 72 });

	await commands.get("mdview").handler("README.md", ctx);
	const rendered = stripAnsi(ctx._customCalls[0].firstRender.join("\n"));
	check("/mdview abre UI personalizada", ctx._customCalls.length === 1, String(ctx._customCalls.length));
	check("/mdview renderiza el título", /Hello Markdown/.test(rendered), rendered);
	check("/mdview renderiza el cuerpo", /Body text/.test(rendered), rendered);
	check("/mdview muestra la pista de cierre", /q\/Esc cerrar/.test(rendered), rendered);
}

async function scenarioQuotedPath(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-spaces-"));
	await fs.mkdir(path.join(cwd, "docs"));
	await fs.writeFile(path.join(cwd, "docs", "file with spaces.md"), "# Spaced Path\n", "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd });

	await commands.get("mdview").handler('"docs/file with spaces.md"', ctx);
	const rendered = stripAnsi(ctx._customCalls[0].firstRender.join("\n"));
	check("/mdview resuelve rutas relativas entre comillas", /Spaced Path/.test(rendered), rendered);
}

async function scenarioErrors(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-errors-"));
	const { commands } = await loadExtension(url);
	const command = commands.get("mdview");

	const noArgCtx = makeCtx({ cwd });
	await command.handler("", noArgCtx);
	check("/mdview sin argumento no abre UI", noArgCtx._customCalls.length === 0, String(noArgCtx._customCalls.length));
	check("/mdview sin argumento reporta uso", /Uso: \/mdview/.test(noArgCtx._notes.at(-1)?.msg || ""));

	const missingCtx = makeCtx({ cwd });
	await command.handler("missing.md", missingCtx);
	check(
		"/mdview sin archivo no abre UI",
		missingCtx._customCalls.length === 0,
		String(missingCtx._customCalls.length),
	);
	check(
		"/mdview sin archivo reporta error",
		missingCtx._notes.at(-1)?.type === "error",
		JSON.stringify(missingCtx._notes),
	);
}

async function captureConsole(fn) {
	const out = [];
	const err = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...a) => out.push(a.join(" "));
	console.error = (...a) => err.push(a.join(" "));
	try {
		await fn();
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { out: out.join("\n"), err: err.join("\n") };
}

async function scenarioRejectsNonMarkdownExtension(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-non-md-"));
	await fs.writeFile(path.join(cwd, "secret.txt"), "NOT_MARKDOWN_SECRET\n", "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	await commands.get("mdview").handler("secret.txt", ctx);
	check("no Markdown: no abre el visor", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check(
		"no Markdown: informa el requisito de extensión",
		/\.md|\.markdown/i.test(ctx._notes.at(-1)?.msg || ""),
		JSON.stringify(ctx._notes.at(-1)),
	);
}

async function scenarioJsonHeadlessErrorToStderr(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-json-headless-"));
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, mode: "json", hasUI: false });
	const { out, err } = await captureConsole(() => commands.get("mdview").handler("missing.md", ctx));
	check(
		"json sin UI: el error va a stderr, no a stdout",
		/No se pudo leer/.test(err) && !/No se pudo leer/.test(out),
		JSON.stringify({ out, err }),
	);
	check("json sin UI: nunca usa ui.notify", ctx._notes.length === 0, JSON.stringify(ctx._notes));
}

async function scenarioLargeFileGuard(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-large-"));
	await fs.writeFile(path.join(cwd, "big.md"), `# Big\n${"x".repeat(3_000_000)}\n`, "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	await commands.get("mdview").handler("big.md", ctx);
	check("archivo grande: no abre el visor", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check(
		"archivo grande: avisa por tamaño",
		/grande/i.test(ctx._notes.at(-1)?.msg || "") && ctx._notes.at(-1)?.type === "warning",
		JSON.stringify(ctx._notes.at(-1)),
	);
}

async function scenarioPrintModeStdout(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-print-"));
	await fs.writeFile(path.join(cwd, "doc.md"), "# Heading\n\nplain body\n", "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, mode: "print" });
	const { out } = await captureConsole(() => commands.get("mdview").handler("doc.md", ctx));
	// A nivel unitario: el handler emite el documento vía console.log. Bajo el binario real
	// `pi --print`, ese stream se enruta a stderr (ver scenarioPrintModeRealStdout).
	check("print: emite el contenido vía console.log", out.includes("plain body"), out);
	check("print: no abre UI personalizada", ctx._customCalls.length === 0, String(ctx._customCalls.length));
}

async function scenarioPrintModeErrorToStderr(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-print-err-"));
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, mode: "print" });
	const { out, err } = await captureConsole(() => commands.get("mdview").handler("missing.md", ctx));
	check(
		"print-error: el error va a stderr, no a stdout",
		/No se pudo leer/.test(err) && !/No se pudo leer/.test(out),
		JSON.stringify({ out, err }),
	);
}

function findPiCli() {
	const which = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" });
	if (which.status !== 0) return { ok: false, reason: "`pi` CLI not on PATH" };
	return { ok: true, command: which.stdout.trim() || "pi" };
}

// End-to-end contra el binario real `pi --print` para ejercitar la toma de stdout de pi
// (reserva stdout real para la respuesta del modelo y enruta toda la salida de consola
// de la extensión a stderr). Un console.log mockeado nunca puede revelar
// esto, que es exactamente por lo que los checks unitarios in-process dieron falsa confianza.
async function scenarioPrintModeRealStdout() {
	const piCli = findPiCli();
	if (!piCli.ok) {
		console.log(`SKIP: print-real: ${piCli.reason}`);
		return;
	}
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-print-real-"));
	const docPath = path.join(cwd, "doc.md");
	await fs.writeFile(docPath, "# Heading\n\nUNIQUE_BODY_TOKEN\n", "utf8");
	const extPath = path.join(REPO_ROOT, "extensions", "pandi-mdview");
	const r = spawnSync(
		piCli.command,
		["--no-extensions", "-e", extPath, "--no-session", "--print", `/mdview ${docPath}`],
		{
			cwd,
			encoding: "utf8",
			timeout: 30000,
		},
	);
	const stdout = r.stdout || "";
	const stderr = r.stderr || "";
	check("print-real: sale limpio", r.status === 0, JSON.stringify({ status: r.status, err: stderr.slice(0, 200) }));
	// Contrato honesto: pi reserva stdout real para la respuesta del modelo, así que el
	// documento se emite a la terminal vía stderr; `pi /mdview f.md > out.md`
	// no captura nada. Estas dos verificaciones fijan ese enrutamiento real.
	check(
		"print-real: el documento se emite a la terminal (stderr)",
		stderr.includes("UNIQUE_BODY_TOKEN"),
		JSON.stringify({ stderrLen: stderr.length }),
	);
	check(
		"print-real: stdout no lleva contenido del documento (reservado para la salida del modelo)",
		!stdout.includes("UNIQUE_BODY_TOKEN"),
		JSON.stringify({ stdoutLen: stdout.length }),
	);
}

async function main() {
	const { outDir, url } = await buildMdview();
	try {
		await scenarioRegisters(url);
		await scenarioPackageDeclaresRuntimePeers();
		await scenarioRendersRelativePath(url);
		await scenarioQuotedPath(url);
		await scenarioErrors(url);
		await scenarioRejectsNonMarkdownExtension(url);
		await scenarioJsonHeadlessErrorToStderr(url);
		await scenarioLargeFileGuard(url);
		await scenarioPrintModeStdout(url);
		await scenarioPrintModeErrorToStderr(url);
		await scenarioPrintModeRealStdout();
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
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
