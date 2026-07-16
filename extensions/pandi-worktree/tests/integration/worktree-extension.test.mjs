#!/usr/bin/env node
/**
 * Test de integración de comportamiento duradero para extensions/pandi-worktree/index.ts.
 *
 * Fija el contrato público de la extensión worktree contra repos git REALES
 * creados en dirs de mkdtemp (evidencia honesta: git se invoca de verdad):
 * - el comando /worktree y la herramienta git_worktree quedan registrados
 * - list parsea la salida porcelain (incluido el worktree principal)
 * - add -b crea el directorio del worktree + la rama nueva
 * - remove se niega ante un worktree sucio sin force y funciona con force
 * - prune --dry-run informa sin borrar; prune real limpia metadatos obsoletos
 * - fuera de un repo git: error acotado, sin mutación del worktree
 * - los helpers puros (parseWorktreeList / isValidBranchName / describeWorktree) y
 *   el parser del comando (tokenize / parseCommand / buildAddArgs) + completions
 *   de subcomandos se prueban unitariamente directo contra los exports del bundle
 * - un repo bare se acepta como contexto git utilizable
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function git(cwd, args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	return r.stdout;
}

async function makeRepo() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-repo-"));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	await fs.writeFile(path.join(dir, "file.txt"), "hello\n", "utf8");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

async function buildBundle() {
	// Stubeá el SDK para que esbuild no arrastre el runtime verdadero de @earendil-works/pi-coding-agent
	// (transitivamente requiere cross-spawn, que usa un require dinámico que rompe
	// un bundle ESM). worktree.ts solo necesita CONFIG_DIR_NAME como valor; index.ts
	// usa el paquete solo para tipos (se borran). Mismo enfoque que pandi-bg.
	return await buildExtension({
		name: "pi-worktree-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-worktree", "index.ts"),
		outName: "worktree.mjs",
		stubs: { sdk: 'export const CONFIG_DIR_NAME = ".pi";\n' },
		npx: "--no-install",
	});
}

async function buildRunnerBundle() {
	return await buildExtension({
		name: "pi-worktree-runner-build",
		src: path.join(REPO_ROOT, "extensions", "pandi-worktree", "worktree.ts"),
		outName: "worktree-runner.mjs",
		stubs: { sdk: 'export const CONFIG_DIR_NAME = ".pi";\n' },
		npx: "--no-install",
	});
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	const events = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
			on: (event, handler) => events.set(event, handler),
		},
		commands,
		tools,
		events,
	};
}

function selectExactMenuItem(expected) {
	return (items) => {
		check(`interactive menu contains ${expected}`, items.includes(expected), JSON.stringify(items));
		return expected;
	};
}

function makeCtx({ cwd, mode = "tui", confirm = true, selectValue, inputValues } = {}) {
	const notes = [];
	const confirms = [];
	const inputs = [...(inputValues ?? [])];
	const ctx = {
		mode,
		hasUI: mode !== "print",
		cwd,
		signal: undefined,
		ui: {
			notify: (msg, type) => notes.push({ msg, type }),
			confirm: async (title, body) => {
				confirms.push({ title, body });
				return typeof confirm === "function" ? confirm(title, body) : confirm;
			},
			select: async (_title, items) => (typeof selectValue === "function" ? selectValue(items) : selectValue),
			input: async (_title, _def) => (inputs.length ? inputs.shift() : ""),
		},
	};
	ctx._notes = notes;
	ctx._confirms = confirms;
	return ctx;
}

function lastNote(ctx) {
	return ctx._notes.at(-1) ?? { msg: "", type: undefined };
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

// --- bloques unitarios: helpers puros + parser, probados contra los exports del bundle ---

async function scenarioParseHelpers(url) {
	const mod = await loadModule(url);

	// parseWorktreeList: porcelain sintético de varios registros que cubre cada flag,
	// un locked reason, un prunable reason, finales de línea CRLF y un registro sin HEAD.
	const porcelain = [
		"worktree /repo/main",
		"HEAD 1111111111111111111111111111111111111111",
		"branch refs/heads/main",
		"",
		"worktree /repo/bare",
		"bare",
		"",
		"worktree /repo/detached",
		"HEAD 2222222222222222222222222222222222222222",
		"detached",
		"",
		"worktree /repo/locked",
		"HEAD 3333333333333333333333333333333333333333",
		"branch refs/heads/locked-b",
		"locked needs review",
		"",
		"worktree /repo/prunable\r",
		"HEAD 4444444444444444444444444444444444444444\r",
		"branch refs/heads/prune-b\r",
		"prunable gitdir file points to non-existent location\r",
		"",
		"worktree /repo/nohead",
		"branch refs/heads/nohead-b",
		"",
	].join("\n");
	const entries = mod.parseWorktreeList(porcelain);
	check("parseWorktreeList: parses all six records", entries.length === 6, String(entries.length));

	const [main, bare, detached, locked, prunable, nohead] = entries;
	check("parseWorktreeList: main branchShort", main.branchShort === "main", JSON.stringify(main));
	check("parseWorktreeList: main no flags", !main.bare && !main.detached && !main.locked && !main.prunable);
	check("parseWorktreeList: bare flag", bare.bare === true, JSON.stringify(bare));
	check(
		"parseWorktreeList: detached flag + head",
		detached.detached === true && detached.head?.startsWith("2222"),
		JSON.stringify(detached),
	);
	check(
		"parseWorktreeList: locked flag + reason",
		locked.locked === true && locked.lockedReason === "needs review",
		JSON.stringify(locked),
	);
	check(
		"parseWorktreeList: prunable flag + reason",
		prunable.prunable === true && prunable.prunableReason === "gitdir file points to non-existent location",
		JSON.stringify(prunable),
	);
	check("parseWorktreeList: CRLF stripped from branch", prunable.branchShort === "prune-b", JSON.stringify(prunable));
	check(
		"parseWorktreeList: record without HEAD still parsed",
		nohead.head === undefined && nohead.branchShort === "nohead-b",
		JSON.stringify(nohead),
	);

	// describeWorktree: salidas representativas.
	check("describeWorktree: bare label", mod.describeWorktree(bare).includes("(bare)"), mod.describeWorktree(bare));
	check(
		"describeWorktree: detached label",
		/\(detached 22222222\)/.test(mod.describeWorktree(detached)),
		mod.describeWorktree(detached),
	);
	check(
		"describeWorktree: locked suffix",
		/\[bloqueado\]/.test(mod.describeWorktree(locked)),
		mod.describeWorktree(locked),
	);
	check(
		"describeWorktree: prunable suffix",
		/\[limpiable\]/.test(mod.describeWorktree(prunable)),
		mod.describeWorktree(prunable),
	);

	// tabla de isValidBranchName.
	for (const [name, expected] of [
		["feature/x", true],
		["-x", false],
		["x..y", false],
		["x.lock", false],
		["@", false],
		["a//b", false],
		[".hidden", false],
		["has space", false],
	]) {
		check(
			`isValidBranchName(${JSON.stringify(name)}) === ${expected}`,
			mod.isValidBranchName(name) === expected,
			name,
		);
	}
}

async function scenarioParseCommand(url) {
	const mod = await loadModule(url);
	const p = mod.parseCommand;

	check(
		"tokenize: honors quotes",
		JSON.stringify(mod.tokenize('add "a b" c')) === JSON.stringify(["add", "a b", "c"]),
		JSON.stringify(mod.tokenize('add "a b" c')),
	);

	const add = p("add -b feat ./x main");
	check(
		"parseCommand add: shape",
		add.action === "add" && add.path === "./x" && add.newBranch === "feat" && add.commitish === "main",
		JSON.stringify(add),
	);

	const quoted = p('add "a b/c"');
	check("parseCommand add: quoted path with space", quoted.path === "a b/c", JSON.stringify(quoted));

	const rm = p("remove --force ./x");
	check(
		"parseCommand remove: force + path",
		rm.action === "remove" && rm.force === true && rm.path === "./x",
		JSON.stringify(rm),
	);

	const prune = p("prune -n");
	check("parseCommand prune: dryRun", prune.action === "prune" && prune.dryRun === true, JSON.stringify(prune));

	const bogus = p("bogus");
	check(
		"parseCommand bogus: help + unknown-subcommand error",
		bogus.action === "help" && /desconocido/i.test(bogus.error || ""),
		JSON.stringify(bogus),
	);
}

async function scenarioBuildAddArgs(url) {
	const mod = await loadModule(url);
	const full = mod.buildAddArgs({
		path: "/p",
		newBranch: "b",
		commitish: "main",
		detach: true,
		force: true,
	});
	check(
		"buildAddArgs: full order (--force → --detach → -b → -- → path → commitish)",
		JSON.stringify(full) ===
			JSON.stringify(["worktree", "add", "--force", "--detach", "-b", "b", "--", "/p", "main"]),
		JSON.stringify(full),
	);
	const dashCommit = mod.buildAddArgs({ path: "/p", commitish: "--force" });
	check(
		"buildAddArgs: '--' makes a dash-leading commitish positional",
		JSON.stringify(dashCommit) === JSON.stringify(["worktree", "add", "--", "/p", "--force"]),
		JSON.stringify(dashCommit),
	);
}

async function scenarioRunGitProcessContract() {
	const built = await buildRunnerBundle();
	const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-fake-git-"));
	const fakeGit = path.join(fakeBinDir, "git");
	const source = `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === "stubborn") {
	${
		process.platform === "win32"
			? ""
			: `const { spawn } = require("node:child_process");
	spawn(process.execPath, ["-e", ${JSON.stringify(
		[
			'process.on("SIGTERM", () => process.stdout.write("descendiente recibió SIGTERM\\\\n"));',
			"setInterval(() => {}, 1_000);",
			"setTimeout(() => process.exit(0), 1_500).unref();",
		].join(""),
	)}], { stdio: "inherit" });`
	}
	process.on("SIGTERM", () => process.stdout.write("hijo recibió SIGTERM\\n"));
	setInterval(() => {}, 1_000);
	setTimeout(() => process.exit(23), 1_500).unref();
} else if (mode === "signal") {
	setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
} else if (mode === "normal") {
	process.stdout.write("salida normal\\n");
	process.stderr.write("error normal\\n");
} else if (mode === "large") {
	const prefix = "a".repeat(999_999);
	process.stdout.write(prefix + "€x");
	process.stderr.write(prefix + "€x");
}
`;
	await fs.writeFile(fakeGit, source, "utf8");
	await fs.chmod(fakeGit, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
	try {
		const mod = await loadModule(built.url);
		const sawWholeTreeTermination = (stdout) =>
			stdout.includes("hijo recibió SIGTERM") &&
			(process.platform === "win32" || stdout.includes("descendiente recibió SIGTERM"));
		const timedOut = await mod.runGit(["stubborn"], { cwd: REPO_ROOT, timeoutMs: 400 });
		check(
			"runGit: timeout signals the supported process group, escalates and resolves after inherited pipes close",
			!timedOut.ok &&
				timedOut.timedOut === true &&
				timedOut.aborted === false &&
				timedOut.signal === "SIGKILL" &&
				sawWholeTreeTermination(timedOut.stdout),
			JSON.stringify(timedOut),
		);

		const controller = new AbortController();
		const pending = mod.runGit(["stubborn"], {
			cwd: REPO_ROOT,
			signal: controller.signal,
			timeoutMs: 30_000,
		});
		setTimeout(() => controller.abort(), 400);
		const aborted = await pending;
		check(
			"runGit: abort signals the supported process group, escalates and remains distinct",
			!aborted.ok &&
				aborted.timedOut === false &&
				aborted.aborted === true &&
				aborted.signal === "SIGKILL" &&
				sawWholeTreeTermination(aborted.stdout),
			JSON.stringify(aborted),
		);

		const signaled = await mod.runGit(["signal"], { cwd: REPO_ROOT, timeoutMs: 5_000 });
		check(
			"runGit: child signal termination is neither timeout nor external abort",
			!signaled.ok && signaled.timedOut === false && signaled.aborted === false && signaled.signal === "SIGTERM",
			JSON.stringify(signaled),
		);

		const normal = await mod.runGit(["normal"], { cwd: REPO_ROOT, timeoutMs: 5_000 });
		check(
			"runGit: ordinary stdout/stderr stay unchanged and untruncated",
			normal.ok === true &&
				normal.stdout === "salida normal\n" &&
				normal.stderr === "error normal\n" &&
				normal.stdoutTruncated === false &&
				normal.stderrTruncated === false,
			JSON.stringify(normal),
		);

		const large = await mod.runGit(["large"], { cwd: REPO_ROOT, timeoutMs: 5_000 });
		check(
			"runGit: byte cap keeps valid UTF-8 when a multibyte character crosses the boundary",
			large.ok === true &&
				Buffer.byteLength(large.stdout) <= 1_000_000 &&
				Buffer.byteLength(large.stderr) <= 1_000_000 &&
				large.stdoutTruncated === true &&
				large.stderrTruncated === true &&
				!large.stdout.includes("\uFFFD") &&
				!large.stderr.includes("\uFFFD"),
			JSON.stringify({
				ok: large.ok,
				stdoutBytes: Buffer.byteLength(large.stdout),
				stderrBytes: Buffer.byteLength(large.stderr),
				stdoutTruncated: large.stdoutTruncated,
				stderrTruncated: large.stderrTruncated,
			}),
		);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await fs.rm(fakeBinDir, { recursive: true, force: true });
		await fs.rm(built.outDir, { recursive: true, force: true });
	}
}

async function scenarioTruncatedListRejected(url) {
	const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-truncated-git-"));
	const fakeGit = path.join(fakeBinDir, "git");
	const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "rev-parse") {
	process.stdout.write(".git\\n");
} else if (args[0] === "worktree" && args[1] === "list") {
	process.stdout.write("worktree /tmp/partial\\nHEAD 0000000000000000000000000000000000000000\\nbranch refs/heads/main\\n\\n" + "x".repeat(1_100_000));
} else {
	process.exitCode = 1;
}
`;
	await fs.writeFile(fakeGit, source, "utf8");
	await fs.chmod(fakeGit, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
	try {
		const { tools } = await loadExtension(url);
		const result = await tools
			.get("git_worktree")
			.execute("id", { action: "list" }, undefined, undefined, makeCtx({ cwd: REPO_ROOT }));
		check(
			"tool list: refuses truncated porcelain instead of presenting partial worktrees",
			result.details?.isError === true &&
				result.details?.stdoutTruncated === true &&
				/truncad/i.test(result.content?.[0]?.text ?? ""),
			JSON.stringify(result),
		);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await fs.rm(fakeBinDir, { recursive: true, force: true });
	}
}

async function scenarioCompletions(url) {
	const { commands } = await loadExtension(url);
	const gac = commands.get("worktree").getArgumentCompletions;
	const re = gac("re");
	check(
		"completions: 're' → remove",
		Array.isArray(re) && re.length === 1 && re[0].value === "remove",
		JSON.stringify(re),
	);
	check("completions: second token → null", gac("add ") === null, JSON.stringify(gac("add ")));
	check("completions: no match → null", gac("zzz") === null, JSON.stringify(gac("zzz")));
	const all = gac("");
	check("completions: empty → all seven subcommands", Array.isArray(all) && all.length === 7, JSON.stringify(all));
	const setc = gac("se");
	check(
		"completions: 'se' → set",
		Array.isArray(setc) && setc.length === 1 && setc[0].value === "set",
		JSON.stringify(setc),
	);
	const op = gac("op");
	check(
		"completions: 'op' → open",
		Array.isArray(op) && op.length === 1 && op[0].value === "open",
		JSON.stringify(op),
	);
}

async function scenarioOpenFallback(url) {
	// Forzá la ruta no-Supacode para que el test nunca haga spawn de una pestaña real,
	// incluso cuando la suite misma corra dentro de Supacode. isSupacode() lee esto al
	// momento de la llamada, así que limpiarlo acá alcanza; restauralo en finally.
	const saved = { term: process.env.TERM_PROGRAM, sock: process.env.SUPACODE_SOCKET_PATH };
	delete process.env.TERM_PROGRAM;
	delete process.env.SUPACODE_SOCKET_PATH;
	try {
		const cwd = await makeRepo();
		const { commands, tools } = await loadExtension(url);

		// Comando: crear-si-falta bajo la base por defecto y luego informar cómo abrirlo.
		const ctx = makeCtx({ cwd });
		await commands.get("worktree").handler("open -b open-feat open-wt", ctx);
		const wtPath = path.join(cwd, ".pi", "worktrees", "open-wt");
		check("open cmd: created the worktree dir", existsSync(wtPath), wtPath);
		check("open cmd: created the branch", /open-feat/.test(git(cwd, ["branch", "--list", "open-feat"])));
		check("open cmd: reports cd+pi (fallback)", /cd .* && pi/.test(lastNote(ctx).msg), lastNote(ctx).msg);
		check("open cmd: not an error note", lastNote(ctx).type !== "error", String(lastNote(ctx).type));

		// Herramienta: abrir un worktree EXISTENTE no lo recrea.
		const res = await tools
			.get("git_worktree")
			.execute("id", { action: "open", path: "open-wt" }, undefined, undefined, makeCtx({ cwd }));
		check("open tool: not an error", !res.details?.isError, JSON.stringify(res.details));
		check("open tool: created=false for existing", res.details?.created === false, JSON.stringify(res.details));
		check("open tool: opened=false in fallback", res.details?.opened === false, JSON.stringify(res.details));
		check("open tool: text mentions cd+pi", /cd .* && pi/.test(res.content?.[0]?.text || ""), res.content?.[0]?.text);

		// Herramienta: un nombre de rama inválido da un error acotado; no se crea ningún directorio.
		const bad = await tools
			.get("git_worktree")
			.execute(
				"id",
				{ action: "open", path: "open-bad", branch: "bad name~x" },
				undefined,
				undefined,
				makeCtx({ cwd }),
			);
		check("open tool: invalid branch is an error", bad.details?.isError === true, JSON.stringify(bad.details));
		check("open tool: invalid branch made no dir", !existsSync(path.join(cwd, ".pi", "worktrees", "open-bad")));
	} finally {
		if (saved.term !== undefined) process.env.TERM_PROGRAM = saved.term;
		else delete process.env.TERM_PROGRAM;
		if (saved.sock !== undefined) process.env.SUPACODE_SOCKET_PATH = saved.sock;
		else delete process.env.SUPACODE_SOCKET_PATH;
	}
}

async function scenarioBareRepo(url) {
	const bare = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-bare-"));
	git(bare, ["init", "-q", "--bare", "-b", "main"]);
	const { tools } = await loadExtension(url);
	const res = await tools
		.get("git_worktree")
		.execute("id", { action: "list" }, undefined, undefined, makeCtx({ cwd: bare }));
	check("bare repo: list is not an error", !res.details?.isError, JSON.stringify(res.details));
}

async function scenarioAddDetachAndPlain(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const tool = tools.get("git_worktree");

	// Agregar detached (commitish HEAD, sin rama).
	const detPath = path.join(cwd, "wt-detached");
	const det = await tool.execute(
		"id",
		{ action: "add", path: detPath, commitish: "HEAD", detach: true },
		undefined,
		undefined,
		makeCtx({ cwd }),
	);
	check("add detach: not an error", !det.details?.isError, JSON.stringify(det.details));
	const listDet = await tool.execute("id", { action: "list" }, undefined, undefined, makeCtx({ cwd }));
	const detEntry = listDet.details?.worktrees?.find((e) => e.path.endsWith("wt-detached"));
	check("add detach: entry is detached", detEntry?.detached === true, JSON.stringify(detEntry));
	await fs.rm(detPath, { recursive: true, force: true });

	// Agregar simple (sin -b, asocia HEAD a una rama nueva nombrada según el path).
	const plainPath = path.join(cwd, "wt-plain");
	const plain = await tool.execute("id", { action: "add", path: plainPath }, undefined, undefined, makeCtx({ cwd }));
	check("add plain: not an error", !plain.details?.isError, JSON.stringify(plain.details));
	check("add plain: directory exists", existsSync(plainPath));
	await fs.rm(plainPath, { recursive: true, force: true });
}

async function scenarioRemoveCommandForce(url) {
	const cwd = await makeRepo();
	const { commands, tools } = await loadExtension(url);
	const wtPath = path.join(cwd, "wt-force");
	await tools
		.get("git_worktree")
		.execute("id", { action: "add", path: wtPath, branch: "force-b" }, undefined, undefined, makeCtx({ cwd }));
	// Ensucialo para que git se niegue sin --force.
	await fs.writeFile(path.join(wtPath, "file.txt"), "changed\n", "utf8");

	const ctx = makeCtx({ cwd, confirm: true }); // confirm devuelve true para ambos prompts
	await commands.get("worktree").handler(`remove ${wtPath}`, ctx);
	check("remove cmd force: prompted twice", ctx._confirms.length === 2, String(ctx._confirms.length));
	check(
		"remove cmd force: second prompt mentions force/dirty",
		/Forzar|cambios sin confirmar|bloqueado/i.test(`${ctx._confirms[1]?.title} ${ctx._confirms[1]?.body}`),
		JSON.stringify(ctx._confirms[1]),
	);
	check("remove cmd force: worktree removed", !existsSync(wtPath));
	check("remove cmd force: note says forced", /\(forzado\)/.test(lastNote(ctx).msg), lastNote(ctx).msg);
}

async function scenarioRegisters(url) {
	const { commands, tools } = await loadExtension(url);
	check("/worktree command registered", commands.has("worktree"));
	check("/worktree has description", /worktree/i.test(commands.get("worktree")?.description || ""));
	check("git_worktree tool registered", tools.has("git_worktree"));
	const tool = tools.get("git_worktree");
	check("git_worktree is sequential", tool?.executionMode === "sequential");
	check(
		"git_worktree has prompt guidelines",
		Array.isArray(tool?.promptGuidelines) && tool.promptGuidelines.length > 0,
	);
}

async function scenarioListCommand(url) {
	const cwd = await makeRepo();
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	await commands.get("worktree").handler("list", ctx);
	const note = lastNote(ctx);
	check("list: reports the main worktree", note.msg.includes(cwd), note.msg);
	check("list: shows the main branch", /main/.test(note.msg), note.msg);
	check("list: info severity", note.type === "info", String(note.type));
}

async function scenarioListTool(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	const res = await tools.get("git_worktree").execute("id", { action: "list" }, undefined, undefined, ctx);
	check("tool list: not an error", !res.details?.isError, JSON.stringify(res.details));
	check("tool list: count >= 1", (res.details?.count ?? 0) >= 1, String(res.details?.count));
	check(
		"tool list: returns parsed worktrees array",
		Array.isArray(res.details?.worktrees),
		typeof res.details?.worktrees,
	);
	check(
		"tool list: main worktree on main branch",
		res.details?.worktrees?.[0]?.branchShort === "main",
		JSON.stringify(res.details?.worktrees?.[0]),
	);
}

async function scenarioAddCreatesBranch(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	const wtPath = path.join(cwd, "..", `${path.basename(cwd)}-feature`);
	const res = await tools
		.get("git_worktree")
		.execute("id", { action: "add", path: wtPath, branch: "feature-x" }, undefined, undefined, ctx);
	check("add: not an error", !res.details?.isError, JSON.stringify(res.details));
	check("add: worktree directory exists", existsSync(res.details?.path), String(res.details?.path));
	const branches = git(cwd, ["branch", "--list", "feature-x"]);
	check("add: created the new branch", /feature-x/.test(branches), branches);
	check("add: text mentions how to open it", /cd .* && pi/.test(res.content?.[0]?.text || ""), res.content?.[0]?.text);
	await fs.rm(wtPath, { recursive: true, force: true });
}

async function scenarioAddInvalidBranch(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	const res = await tools
		.get("git_worktree")
		.execute(
			"id",
			{ action: "add", path: path.join(cwd, "bad"), branch: "bad branch~name" },
			undefined,
			undefined,
			ctx,
		);
	check("add invalid branch: is an error", res.details?.isError === true, JSON.stringify(res.details));
	check("add invalid branch: did not create a dir", !existsSync(path.join(cwd, "bad")));
}

async function scenarioRemoveDirtyNeedsForce(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	const wtPath = path.join(cwd, "wt-dirty");
	await tools
		.get("git_worktree")
		.execute("id", { action: "add", path: wtPath, branch: "dirty-b" }, undefined, undefined, ctx);
	// Ensuciá el worktree.
	await fs.writeFile(path.join(wtPath, "file.txt"), "changed\n", "utf8");

	const refused = await tools
		.get("git_worktree")
		.execute("id", { action: "remove", path: wtPath }, undefined, undefined, ctx);
	check("remove dirty no-force: refuses", refused.details?.isError === true, JSON.stringify(refused.details));
	check("remove dirty no-force: directory still exists", existsSync(wtPath));
	check(
		"remove dirty no-force: hints at force",
		/force=true/.test(refused.content?.[0]?.text || ""),
		refused.content?.[0]?.text,
	);

	const forced = await tools
		.get("git_worktree")
		.execute("id", { action: "remove", path: wtPath, force: true }, undefined, undefined, ctx);
	check("remove dirty force: succeeds", !forced.details?.isError, JSON.stringify(forced.details));
	check("remove dirty force: directory gone", !existsSync(wtPath));
}

async function scenarioRemoveCommandConfirm(url) {
	const cwd = await makeRepo();
	const { commands, tools } = await loadExtension(url);
	const wtPath = path.join(cwd, "wt-clean");
	await tools
		.get("git_worktree")
		.execute("id", { action: "add", path: wtPath, branch: "clean-b" }, undefined, undefined, makeCtx({ cwd }));

	// Rechazar la confirmación → el worktree queda.
	const declineCtx = makeCtx({ cwd, confirm: false });
	await commands.get("worktree").handler(`remove ${wtPath}`, declineCtx);
	check(
		"remove cmd decline: asks for confirmation",
		declineCtx._confirms.length >= 1,
		String(declineCtx._confirms.length),
	);
	check("remove cmd decline: worktree preserved", existsSync(wtPath));

	// Aceptar la confirmación → worktree eliminado (limpio, sin force).
	const acceptCtx = makeCtx({ cwd, confirm: true });
	await commands.get("worktree").handler(`remove ${wtPath}`, acceptCtx);
	check("remove cmd accept: worktree removed", !existsSync(wtPath));
}

async function scenarioPruneDryRun(url) {
	const cwd = await makeRepo();
	const { commands, tools } = await loadExtension(url);
	const wtPath = path.join(cwd, "wt-prunable");
	await tools
		.get("git_worktree")
		.execute("id", { action: "add", path: wtPath, branch: "prune-b" }, undefined, undefined, makeCtx({ cwd }));
	// Borrá el dir del worktree a espaldas de git → sus metadatos pasan a ser prunable.
	await fs.rm(wtPath, { recursive: true, force: true });

	const dry = await tools
		.get("git_worktree")
		.execute("id", { action: "prune", dryRun: true }, undefined, undefined, makeCtx({ cwd }));
	check("prune dry-run: not an error", !dry.details?.isError, JSON.stringify(dry.details));
	// Los metadatos obsoletos siguen presentes después de dry-run.
	const listAfterDry = await tools
		.get("git_worktree")
		.execute("id", { action: "list" }, undefined, undefined, makeCtx({ cwd }));
	check(
		"prune dry-run: still lists the stale worktree",
		JSON.stringify(listAfterDry.details?.worktrees).includes("wt-prunable"),
		JSON.stringify(listAfterDry.details?.worktrees),
	);

	// Prune real vía el comando (sin UI → no hace falta confirmar).
	const pruneCtx = makeCtx({ cwd, mode: "print" });
	await commands.get("worktree").handler("prune", pruneCtx);
	const listAfter = await tools
		.get("git_worktree")
		.execute("id", { action: "list" }, undefined, undefined, makeCtx({ cwd }));
	check(
		"prune: stale worktree metadata cleaned",
		!JSON.stringify(listAfter.details?.worktrees).includes("wt-prunable"),
		JSON.stringify(listAfter.details?.worktrees),
	);
}

async function scenarioDefaultBase(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const res = await tools
		.get("git_worktree")
		.execute("id", { action: "add", path: "feature", branch: "feat" }, undefined, undefined, makeCtx({ cwd }));
	check("default base: not an error", !res.details?.isError, JSON.stringify(res.details));
	const expected = path.join(cwd, ".pi", "worktrees", "feature");
	check(
		"default base: resolves to .pi/worktrees/<name>",
		res.details?.path === expected,
		`${res.details?.path} vs ${expected}`,
	);
	check("default base: marks defaultBase=true", res.details?.defaultBase === true, JSON.stringify(res.details));
	check("default base: worktree directory exists", existsSync(expected));
	const giPath = path.join(cwd, ".pi", "worktrees", ".gitignore");
	check("default base: writes .pi/worktrees/.gitignore", existsSync(giPath));
	const gi = existsSync(giPath) ? await fs.readFile(giPath, "utf8") : "";
	check("default base: .gitignore ignores everything", gi.trim() === "*", JSON.stringify(gi));
	// Toda la base debe ser invisible para el repo PRINCIPAL (depende solo del
	// .gitignore autocontenido: el repo temporal no tiene ninguna entrada ignore en raíz).
	const status = git(cwd, ["status", "--porcelain"]);
	check("default base: worktree is gitignored (clean status)", !status.includes(".pi/worktrees"), status);
}

async function scenarioExplicitPathEscapesDefault(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const res = await tools
		.get("git_worktree")
		.execute("id", { action: "add", path: "sub/nested-wt", branch: "nb" }, undefined, undefined, makeCtx({ cwd }));
	const expected = path.join(cwd, "sub", "nested-wt");
	check(
		"explicit slash path: literal under cwd",
		res.details?.path === expected,
		`${res.details?.path} vs ${expected}`,
	);
	check("explicit slash path: not default base", res.details?.defaultBase === false, JSON.stringify(res.details));
	check("explicit slash path: did not create .pi/worktrees", !existsSync(path.join(cwd, ".pi", "worktrees")));
	await fs.rm(path.join(cwd, "sub"), { recursive: true, force: true });
}

async function scenarioOutsideRepo(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-nogit-"));
	const { commands, tools } = await loadExtension(url);

	const cmdCtx = makeCtx({ cwd });
	await commands.get("worktree").handler("list", cmdCtx);
	check("outside repo cmd: errors", lastNote(cmdCtx).type === "error", JSON.stringify(lastNote(cmdCtx)));

	const toolCtx = makeCtx({ cwd });
	const res = await tools.get("git_worktree").execute("id", { action: "list" }, undefined, undefined, toolCtx);
	check("outside repo tool: errors", res.details?.isError === true, JSON.stringify(res.details));
}

async function scenarioInteractiveAdd(url) {
	const cwd = await makeRepo();
	const { commands } = await loadExtension(url);
	const wtPath = path.join(cwd, "wt-interactive");
	const ctx = makeCtx({
		cwd,
		selectValue: selectExactMenuItem("add — crear un worktree"),
		inputValues: [wtPath, "interactive-b"],
	});
	await commands.get("worktree").handler("", ctx);
	check("interactive add: created worktree dir", existsSync(wtPath));
	const branches = git(cwd, ["branch", "--list", "interactive-b"]);
	check("interactive add: created branch", /interactive-b/.test(branches), branches);
	await fs.rm(wtPath, { recursive: true, force: true });
}

// --- copiar archivos ignored/untracked a worktrees nuevos (funcionalidad) ---

async function scenarioCopyFilters(url) {
	const mod = await loadModule(url);
	check(
		"buildListIgnoredArgs: ls-files -z --others --ignored --exclude-standard --directory",
		JSON.stringify(mod.buildListIgnoredArgs()) ===
			JSON.stringify(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]),
		JSON.stringify(mod.buildListIgnoredArgs()),
	);
	check(
		"buildListUntrackedArgs: ls-files -z --others --exclude-standard --directory",
		JSON.stringify(mod.buildListUntrackedArgs()) ===
			JSON.stringify(["ls-files", "-z", "--others", "--exclude-standard", "--directory"]),
		JSON.stringify(mod.buildListUntrackedArgs()),
	);
	check(
		"parseLsFilesEntries: splits NUL and preserves literal path characters",
		JSON.stringify(mod.parseLsFilesEntries(" node_modules/\0name with trailing space \0line\nbreak\0tab\tname\0")) ===
			JSON.stringify([" node_modules/", "name with trailing space ", "line\nbreak", "tab\tname"]),
		JSON.stringify(mod.parseLsFilesEntries(" node_modules/\0name with trailing space \0line\nbreak\0tab\tname\0")),
	);
	const filtered = mod.filterCopyableEntries(
		["node_modules/", ".env", ".pi/worktrees/", ".pi/worktrees/other/", ".pi/", ".git", "a/.git", "dist/"],
		{ configDirName: ".pi" },
	);
	check(
		"filterCopyableEntries: keeps deps, drops worktrees base + ancestor + .git",
		JSON.stringify(filtered) === JSON.stringify(["node_modules", ".env", "dist"]),
		JSON.stringify(filtered),
	);
}

async function scenarioCopyFilesIntoWorktree(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-copy-"));
	git(cwd, ["init", "-q", "-b", "main"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	git(cwd, ["config", "user.name", "Test"]);
	await fs.writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");
	await fs.writeFile(path.join(cwd, "file.txt"), "hello\n", "utf8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-q", "-m", "init"]);
	// un archivo de dependencia gitignored + un archivo scratch untracked
	await fs.mkdir(path.join(cwd, "node_modules"), { recursive: true });
	await fs.writeFile(path.join(cwd, "node_modules", "dep.js"), "module.exports = 1;\n", "utf8");
	await fs.writeFile(path.join(cwd, "scratch.txt"), "scratch\n", "utf8");

	const { tools } = await loadExtension(url);
	const tool = tools.get("git_worktree");

	// copyIgnored: se copian archivos ignorados por git; los sin seguimiento NO; nunca se recorre la base de worktrees.
	const ig = await tool.execute(
		"id",
		{ action: "add", path: "wt-ignored", branch: "b-ig", copyIgnored: true },
		undefined,
		undefined,
		makeCtx({ cwd }),
	);
	check("copyIgnored: not an error", !ig.details?.isError, JSON.stringify(ig.details));
	const igWt = path.join(cwd, ".pi", "worktrees", "wt-ignored");
	check("copyIgnored: node_modules/dep.js copied", existsSync(path.join(igWt, "node_modules", "dep.js")));
	check("copyIgnored: untracked scratch.txt NOT copied", !existsSync(path.join(igWt, "scratch.txt")));
	check("copyIgnored: worktrees base NOT recursed into new wt", !existsSync(path.join(igWt, ".pi", "worktrees")));
	check(
		"copyIgnored: result mentions copied count",
		/se copiaron .*ignorados/.test(ig.content?.[0]?.text || ""),
		ig.content?.[0]?.text,
	);

	// copyUntracked: se copian archivos sin seguimiento; los ignorados NO.
	const un = await tool.execute(
		"id",
		{ action: "add", path: "wt-untracked", branch: "b-un", copyUntracked: true },
		undefined,
		undefined,
		makeCtx({ cwd }),
	);
	check("copyUntracked: not an error", !un.details?.isError, JSON.stringify(un.details));
	const unWt = path.join(cwd, ".pi", "worktrees", "wt-untracked");
	check("copyUntracked: scratch.txt copied", existsSync(path.join(unWt, "scratch.txt")));
	check("copyUntracked: ignored node_modules NOT copied", !existsSync(path.join(unWt, "node_modules")));

	// default (sin flags): no se copia ninguno; se preserva el comportamiento actual.
	const none = await tool.execute(
		"id",
		{ action: "add", path: "wt-none", branch: "b-none" },
		undefined,
		undefined,
		makeCtx({ cwd }),
	);
	check("default: not an error", !none.details?.isError, JSON.stringify(none.details));
	const noneWt = path.join(cwd, ".pi", "worktrees", "wt-none");
	check("default: node_modules NOT copied", !existsSync(path.join(noneWt, "node_modules")));
	check("default: scratch.txt NOT copied", !existsSync(path.join(noneWt, "scratch.txt")));

	// los flags del comando se parsean a la intención estructurada.
	const mod = await loadModule(url);
	const parsed = mod.parseCommand("add --copy-ignored --copy-untracked wt-cmd");
	check(
		"parseCommand: --copy-ignored/--copy-untracked set the flags",
		parsed.copyIgnored === true && parsed.copyUntracked === true && parsed.path === "wt-cmd",
		JSON.stringify(parsed),
	);
	await fs.rm(cwd, { recursive: true, force: true });
}

// --- superficie de valor por defecto de copia "set" (pasar por llamada O valor por defecto de sesión/env) ---

async function scenarioCopyPrefsResolution(url) {
	const mod = await loadModule(url);

	// precedence: param explícito -> valor por defecto de sesión -> env -> false.
	mod.resetSessionCopyDefaults();
	const base = mod.resolveCopyPrefs({});
	check(
		"resolveCopyPrefs: defaults off",
		base.copyIgnored === false && base.copyUntracked === false,
		JSON.stringify(base),
	);

	const paramOn = mod.resolveCopyPrefs({ copyIgnored: true });
	check("resolveCopyPrefs: explicit param wins (on)", paramOn.copyIgnored === true, JSON.stringify(paramOn));

	mod.setSessionCopyDefault("copyIgnored", true);
	const sessionOn = mod.resolveCopyPrefs({});
	check("resolveCopyPrefs: session default applies", sessionOn.copyIgnored === true, JSON.stringify(sessionOn));
	const paramOffOverridesSession = mod.resolveCopyPrefs({ copyIgnored: false });
	check(
		"resolveCopyPrefs: explicit false overrides session default",
		paramOffOverridesSession.copyIgnored === false,
		JSON.stringify(paramOffOverridesSession),
	);
	mod.resetSessionCopyDefaults();
	const afterReset = mod.resolveCopyPrefs({});
	check(
		"resolveCopyPrefs: reset clears session default",
		afterReset.copyIgnored === false,
		JSON.stringify(afterReset),
	);

	// parseCopyToggleValue
	check("parseCopyToggleValue: on", mod.parseCopyToggleValue("on") === "on");
	check("parseCopyToggleValue: off alias", mod.parseCopyToggleValue("disable") === "off");
	check("parseCopyToggleValue: empty -> status", mod.parseCopyToggleValue("") === "status");
	check("parseCopyToggleValue: bogus -> invalid", mod.parseCopyToggleValue("x") === "invalid");

	// parser: los flags de negación vuelven tri-state la copia; subcomando set.
	const noIg = mod.parseCommand("add --no-copy-ignored wt");
	check("parseCommand: --no-copy-ignored => false", noIg.copyIgnored === false, JSON.stringify(noIg));
	const plain = mod.parseCommand("add wt");
	check("parseCommand: no copy flag => undefined", plain.copyIgnored === undefined, JSON.stringify(plain));
	const setOn = mod.parseCommand("set copy-ignored on");
	check(
		"parseCommand: set copy-ignored on",
		setOn.action === "set" && setOn.setTarget === "copy-ignored" && setOn.setValue === "on",
		JSON.stringify(setOn),
	);
	const setStatus = mod.parseCommand("set");
	check(
		"parseCommand: bare set => status",
		setStatus.action === "set" && !setStatus.setTarget,
		JSON.stringify(setStatus),
	);
	const setWriterGuard = mod.parseCommand("set writer-guard on");
	check(
		"parseCommand: set writer-guard on",
		setWriterGuard.action === "set" &&
			setWriterGuard.setTarget === "writer-guard" &&
			setWriterGuard.setValue === "on",
		JSON.stringify(setWriterGuard),
	);
	const setBogus = mod.parseCommand("set bogus on");
	check("parseCommand: set bogus => error", setBogus.action === "set" && !!setBogus.error, JSON.stringify(setBogus));
}

async function scenarioCopyPrefsSetCommand(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-setpref-"));
	git(cwd, ["init", "-q", "-b", "main"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	git(cwd, ["config", "user.name", "Test"]);
	await fs.writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");
	await fs.writeFile(path.join(cwd, "file.txt"), "hello\n", "utf8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-q", "-m", "init"]);
	await fs.mkdir(path.join(cwd, "node_modules"), { recursive: true });
	await fs.writeFile(path.join(cwd, "node_modules", "dep.js"), "module.exports = 1;\n", "utf8");

	// Una instancia de la extensión para que el manejador del comando + la herramienta compartan el singleton del valor por defecto de sesión.
	const { commands, tools } = await loadExtension(url);
	const handler = commands.get("worktree").handler;
	const tool = tools.get("git_worktree");

	// poné el valor por defecto de sesión en ON; luego un add simple (sin flag) debe copiar node_modules.
	const setCtx = makeCtx({ cwd });
	await handler("set copy-ignored on", setCtx);
	check(
		"set: note confirms on",
		/copy-ignored/.test(lastNote(setCtx).msg) && setCtx._notes.length > 0,
		lastNote(setCtx).msg,
	);
	await handler("set writer-guard status", setCtx);
	check(
		"set writer-guard: default status is off",
		/writer-guard off/.test(lastNote(setCtx).msg),
		lastNote(setCtx).msg,
	);
	await handler("set writer-guard on", setCtx);
	check("set writer-guard: can enable", /writer-guard on/.test(lastNote(setCtx).msg), lastNote(setCtx).msg);
	await handler("set writer-guard off", setCtx);
	check("set writer-guard: can disable", /writer-guard off/.test(lastNote(setCtx).msg), lastNote(setCtx).msg);

	const added = await tool.execute(
		"id",
		{ action: "add", path: "wt-default-on", branch: "b-on" },
		undefined,
		undefined,
		makeCtx({ cwd }),
	);
	check("set default-on: not an error", !added.details?.isError, JSON.stringify(added.details));
	const onWt = path.join(cwd, ".pi", "worktrees", "wt-default-on");
	check(
		"set default-on: node_modules copied via session default",
		existsSync(path.join(onWt, "node_modules", "dep.js")),
	);

	// false por llamada sobrescribe el valor por defecto de sesión en ON.
	const overridden = await tool.execute(
		"id",
		{ action: "add", path: "wt-override-off", branch: "b-off", copyIgnored: false },
		undefined,
		undefined,
		makeCtx({ cwd }),
	);
	check("override-off: not an error", !overridden.details?.isError, JSON.stringify(overridden.details));
	const offWt = path.join(cwd, ".pi", "worktrees", "wt-override-off");
	check("override-off: node_modules NOT copied", !existsSync(path.join(offWt, "node_modules")));

	await fs.rm(cwd, { recursive: true, force: true });
}

async function main() {
	const { outDir, url } = await buildBundle();
	try {
		await scenarioRegisters(url);
		await scenarioParseHelpers(url);
		await scenarioParseCommand(url);
		await scenarioBuildAddArgs(url);
		await scenarioRunGitProcessContract();
		await scenarioTruncatedListRejected(url);
		await scenarioCompletions(url);
		await scenarioListCommand(url);
		await scenarioListTool(url);
		await scenarioAddCreatesBranch(url);
		await scenarioAddInvalidBranch(url);
		await scenarioAddDetachAndPlain(url);
		await scenarioOpenFallback(url);
		await scenarioRemoveDirtyNeedsForce(url);
		await scenarioRemoveCommandConfirm(url);
		await scenarioRemoveCommandForce(url);
		await scenarioPruneDryRun(url);
		await scenarioDefaultBase(url);
		await scenarioExplicitPathEscapesDefault(url);
		await scenarioOutsideRepo(url);
		await scenarioBareRepo(url);
		await scenarioInteractiveAdd(url);
		await scenarioCopyFilters(url);
		await scenarioCopyFilesIntoWorktree(url);
		await scenarioCopyPrefsResolution(url);
		await scenarioCopyPrefsSetCommand(url);
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
