#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-worktree/index.ts.
 *
 * Pins the public contract of the worktree extension against REAL git repos
 * created in mkdtemp dirs (honest evidence — git is actually invoked):
 * - the /worktree command and git_worktree tool are registered
 * - list parses the porcelain output (including the main worktree)
 * - add -b creates the worktree directory + the new branch
 * - remove refuses a dirty worktree without force, succeeds with force
 * - prune --dry-run reports without deleting; real prune cleans stale metadata
 * - outside a git repo: a bounded error, no worktree mutation
 * - pure helpers (parseWorktreeList / isValidBranchName) behave as specified
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChecker } from "../../../../scripts/test/harness.mjs";

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
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-build-"));
	const src = path.join(REPO_ROOT, "extensions", "pi-worktree", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "worktree.mjs");
	const r = spawnSync(
		"npx",
		["--no-install", "esbuild", src, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed for worktree: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

let instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
		},
		commands,
		tools,
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
	const extension = await freshDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

async function scenarioRegisters(url) {
	const { commands, tools } = await loadExtension(url);
	check("/worktree command registered", commands.has("worktree"));
	check("/worktree has description", /worktree/i.test(commands.get("worktree")?.description || ""));
	check("git_worktree tool registered", tools.has("git_worktree"));
	const tool = tools.get("git_worktree");
	check("git_worktree is sequential", tool?.executionMode === "sequential");
	check("git_worktree has prompt guidelines", Array.isArray(tool?.promptGuidelines) && tool.promptGuidelines.length > 0);
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
	check("tool list: returns parsed worktrees array", Array.isArray(res.details?.worktrees), typeof res.details?.worktrees);
	check("tool list: main worktree on main branch", res.details?.worktrees?.[0]?.branchShort === "main", JSON.stringify(res.details?.worktrees?.[0]));
}

async function scenarioAddCreatesBranch(url) {
	const cwd = await makeRepo();
	const { tools } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	const wtPath = path.join(cwd, "..", path.basename(cwd) + "-feature");
	const res = await tools.get("git_worktree").execute(
		"id",
		{ action: "add", path: wtPath, branch: "feature-x" },
		undefined,
		undefined,
		ctx,
	);
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
	const res = await tools.get("git_worktree").execute(
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
	await tools.get("git_worktree").execute("id", { action: "add", path: wtPath, branch: "dirty-b" }, undefined, undefined, ctx);
	// Make the worktree dirty.
	await fs.writeFile(path.join(wtPath, "file.txt"), "changed\n", "utf8");

	const refused = await tools.get("git_worktree").execute("id", { action: "remove", path: wtPath }, undefined, undefined, ctx);
	check("remove dirty no-force: refuses", refused.details?.isError === true, JSON.stringify(refused.details));
	check("remove dirty no-force: directory still exists", existsSync(wtPath));
	check("remove dirty no-force: hints at force", /force=true/.test(refused.content?.[0]?.text || ""), refused.content?.[0]?.text);

	const forced = await tools.get("git_worktree").execute("id", { action: "remove", path: wtPath, force: true }, undefined, undefined, ctx);
	check("remove dirty force: succeeds", !forced.details?.isError, JSON.stringify(forced.details));
	check("remove dirty force: directory gone", !existsSync(wtPath));
}

async function scenarioRemoveCommandConfirm(url) {
	const cwd = await makeRepo();
	const { commands, tools } = await loadExtension(url);
	const wtPath = path.join(cwd, "wt-clean");
	await tools.get("git_worktree").execute("id", { action: "add", path: wtPath, branch: "clean-b" }, undefined, undefined, makeCtx({ cwd }));

	// Decline confirmation → worktree stays.
	const declineCtx = makeCtx({ cwd, confirm: false });
	await commands.get("worktree").handler(`remove ${wtPath}`, declineCtx);
	check("remove cmd decline: asks for confirmation", declineCtx._confirms.length >= 1, String(declineCtx._confirms.length));
	check("remove cmd decline: worktree preserved", existsSync(wtPath));

	// Accept confirmation → worktree removed (clean, no force needed).
	const acceptCtx = makeCtx({ cwd, confirm: true });
	await commands.get("worktree").handler(`remove ${wtPath}`, acceptCtx);
	check("remove cmd accept: worktree removed", !existsSync(wtPath));
}

async function scenarioPruneDryRun(url) {
	const cwd = await makeRepo();
	const { commands, tools } = await loadExtension(url);
	const wtPath = path.join(cwd, "wt-prunable");
	await tools.get("git_worktree").execute("id", { action: "add", path: wtPath, branch: "prune-b" }, undefined, undefined, makeCtx({ cwd }));
	// Delete the worktree dir behind git's back → its metadata becomes prunable.
	await fs.rm(wtPath, { recursive: true, force: true });

	const dry = await tools.get("git_worktree").execute("id", { action: "prune", dryRun: true }, undefined, undefined, makeCtx({ cwd }));
	check("prune dry-run: not an error", !dry.details?.isError, JSON.stringify(dry.details));
	// Stale metadata still present after dry-run.
	const listAfterDry = await tools.get("git_worktree").execute("id", { action: "list" }, undefined, undefined, makeCtx({ cwd }));
	check("prune dry-run: still lists the stale worktree", JSON.stringify(listAfterDry.details?.worktrees).includes("wt-prunable"), JSON.stringify(listAfterDry.details?.worktrees));

	// Real prune via the command (no UI → no confirm needed).
	const pruneCtx = makeCtx({ cwd, mode: "print" });
	await commands.get("worktree").handler("prune", pruneCtx);
	const listAfter = await tools.get("git_worktree").execute("id", { action: "list" }, undefined, undefined, makeCtx({ cwd }));
	check("prune: stale worktree metadata cleaned", !JSON.stringify(listAfter.details?.worktrees).includes("wt-prunable"), JSON.stringify(listAfter.details?.worktrees));
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
		selectValue: (items) => items.find((i) => i.startsWith("add")),
		inputValues: [wtPath, "interactive-b"],
	});
	await commands.get("worktree").handler("", ctx);
	check("interactive add: created worktree dir", existsSync(wtPath));
	const branches = git(cwd, ["branch", "--list", "interactive-b"]);
	check("interactive add: created branch", /interactive-b/.test(branches), branches);
	await fs.rm(wtPath, { recursive: true, force: true });
}

async function main() {
	const { outDir, url } = await buildBundle();
	try {
		await scenarioRegisters(url);
		await scenarioListCommand(url);
		await scenarioListTool(url);
		await scenarioAddCreatesBranch(url);
		await scenarioAddInvalidBranch(url);
		await scenarioRemoveDirtyNeedsForce(url);
		await scenarioRemoveCommandConfirm(url);
		await scenarioPruneDryRun(url);
		await scenarioOutsideRepo(url);
		await scenarioInteractiveAdd(url);
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
