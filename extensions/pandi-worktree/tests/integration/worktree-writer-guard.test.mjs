#!/usr/bin/env node
/**
 * Regression for issue #75: a worktree should have one active Pi writer.
 *
 * These tests exercise the extension-level guards against real git worktrees:
 * tool calls and user-bash mutations acquire a lease before mutating, a second
 * session in the same git worktree is blocked with an explicit worktree
 * fallback, stale leases recover, and normal shutdown releases cleanly.
 *
 * Run it:
 *   node extensions/pandi-worktree/tests/integration/worktree-writer-guard.test.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildExtension, createChecker, loadDefault, REPO_ROOT } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

function git(cwd, args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	return r.stdout;
}

async function makeRepo() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-writer-"));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	await fs.writeFile(path.join(dir, "file.txt"), "hello\n", "utf8");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

async function buildBundle() {
	return await buildExtension({
		name: "pi-worktree-writer-guard",
		src: path.join(REPO_ROOT, "extensions", "pandi-worktree", "index.ts"),
		outName: "worktree.mjs",
		stubs: { sdk: 'export const CONFIG_DIR_NAME = ".pi";\n' },
		npx: "--no-install",
	});
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
			on: (event, handler) => {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
		},
		commands,
		tools,
		handlers,
	};
}

function makeCtx(cwd, { sessionId, sessionName, sessionFile, mode = "tui" } = {}) {
	return {
		mode,
		hasUI: mode !== "print",
		cwd,
		signal: undefined,
		ui: {
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => "",
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => sessionName,
			getSessionFile: () => sessionFile,
			getEntries: () => [],
		},
	};
}

function toolCallEvent(toolName, input = {}) {
	return {
		type: "tool_call",
		toolCallId: `tc-${Math.random().toString(16).slice(2)}`,
		toolName,
		input,
	};
}

function userBashEvent(cwd, command) {
	return { type: "user_bash", command, cwd, excludeFromContext: false };
}

async function emit(handlers, eventName, event, ctx) {
	for (const handler of handlers.get(eventName) ?? []) {
		const result = await handler(event, ctx);
		if (eventName === "tool_call" && result?.block) return result;
		if (eventName === "user_bash" && result?.result) return result;
	}
	return undefined;
}

async function activate(url, cwd, sessionId) {
	const extension = await loadDefault(url);
	const { pi, handlers } = makePi();
	extension(pi);
	const ctx = makeCtx(cwd, {
		sessionId,
		sessionName: `Session ${sessionId}`,
		sessionFile: path.join(cwd, ".pi", "sessions", `${sessionId}.jsonl`),
	});
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	return { handlers, ctx };
}

async function shutdown(runtime) {
	for (const handler of runtime.handlers.get("session_shutdown") ?? []) {
		await handler({ reason: "exit" }, runtime.ctx);
	}
}

function leasePath(repo) {
	return path.join(repo, ".pi", "worktree-writer.json");
}

async function readLease(repo) {
	return JSON.parse(await fs.readFile(leasePath(repo), "utf8"));
}

function isBlocked(result) {
	return result?.block === true && typeof result.reason === "string";
}

async function scenarioDefaultDisabled(url) {
	const repo = await makeRepo();
	try {
		const first = await activate(url, repo, "writer-a");
		const firstWrite = await emit(
			first.handlers,
			"tool_call",
			toolCallEvent("write", { path: "file.txt", content: "x" }),
			first.ctx,
		);
		check(
			"writer guard is disabled by default: first write allowed",
			firstWrite === undefined,
			JSON.stringify(firstWrite),
		);
		check("writer guard is disabled by default: no lease is created", !existsSync(leasePath(repo)), leasePath(repo));

		const second = await activate(url, repo, "writer-b");
		const secondWrite = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("write", { path: "file.txt", content: "y" }),
			second.ctx,
		);
		check(
			"writer guard is disabled by default: second writer is not blocked",
			secondWrite === undefined,
			JSON.stringify(secondWrite),
		);
		await shutdown(second);
		await shutdown(first);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

async function scenarioActiveConflict(url) {
	const repo = await makeRepo();
	try {
		const first = await activate(url, repo, "writer-a");
		const allowed = await emit(
			first.handlers,
			"tool_call",
			toolCallEvent("write", { path: "file.txt", content: "x" }),
			first.ctx,
		);
		check("first mutating tool call is allowed", allowed === undefined, JSON.stringify(allowed));
		check("first mutating tool call creates the writer lease", existsSync(leasePath(repo)), leasePath(repo));
		const lease = await readLease(repo);
		check("writer lease records the owning session", lease.sessionId === "writer-a", JSON.stringify(lease));

		const second = await activate(url, repo, "writer-b");
		const blocked = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("write", { path: "file.txt", content: "y" }),
			second.ctx,
		);
		check("second active writer in the same worktree is blocked", isBlocked(blocked), JSON.stringify(blocked));
		check(
			"block reason names single-writer conflict",
			/writer|single|worktree/i.test(blocked?.reason ?? ""),
			blocked?.reason,
		);
		check(
			"block reason offers a separate-worktree fallback",
			/\/worktree open|git_worktree/i.test(blocked?.reason ?? ""),
			blocked?.reason,
		);

		const read = await emit(second.handlers, "tool_call", toolCallEvent("read", { path: "file.txt" }), second.ctx);
		check("read-only tool calls are not blocked by another writer", read === undefined, JSON.stringify(read));
		const status = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("bash", { command: "git status --short" }),
			second.ctx,
		);
		check("read-only bash is not blocked by another writer", status === undefined, JSON.stringify(status));
		const quotedRegex = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("bash", { command: "rg 'hello|nope' file.txt" }),
			second.ctx,
		);
		check("read-only bash allows quoted regex pipes", quotedRegex === undefined, JSON.stringify(quotedRegex));
		const quotedRegexPipeline = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("bash", { command: "rg 'hello|nope' file.txt | head -20" }),
			second.ctx,
		);
		check(
			"read-only bash allows pipelines when every command is read-only",
			quotedRegexPipeline === undefined,
			JSON.stringify(quotedRegexPipeline),
		);
		const printfReadOnly = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("bash", { command: "printf 'x\\n'" }),
			second.ctx,
		);
		check(
			"read-only bash allows printf without redirection",
			printfReadOnly === undefined,
			JSON.stringify(printfReadOnly),
		);
		const printfRedirect = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("bash", { command: "printf x > file.txt" }),
			second.ctx,
		);
		check("bash blocks printf redirection", isBlocked(printfRedirect), JSON.stringify(printfRedirect));
		const multilineMutation = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("bash", { command: "git status --short\nrm file.txt" }),
			second.ctx,
		);
		check("bash blocks newline-separated mutations", isBlocked(multilineMutation), JSON.stringify(multilineMutation));
		const worktreeOpen = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("git_worktree", { action: "open", path: "separate" }),
			second.ctx,
		);
		check(
			"worktree-open escape hatch is not blocked by another writer",
			worktreeOpen === undefined,
			JSON.stringify(worktreeOpen),
		);
		const pruneDryRun = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("git_worktree", { action: "prune", dryRun: true }),
			second.ctx,
		);
		check("git_worktree prune dry-run remains read-only", pruneDryRun === undefined, JSON.stringify(pruneDryRun));
		const removeWorktree = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("git_worktree", { action: "remove", path: "some-worktree" }),
			second.ctx,
		);
		check(
			"git_worktree remove is blocked by another writer",
			isBlocked(removeWorktree),
			JSON.stringify(removeWorktree),
		);

		await shutdown(second);
		await shutdown(first);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

async function scenarioStaleLeaseRecovery(url) {
	const repo = await makeRepo();
	try {
		await fs.mkdir(path.dirname(leasePath(repo)), { recursive: true });
		await fs.writeFile(
			leasePath(repo),
			JSON.stringify(
				{
					id: "stale-writer",
					pid: process.pid,
					mode: "tui",
					cwd: repo,
					worktreeRoot: repo,
					sessionId: "stale-session",
					startedAt: "2000-01-01T00:00:00.000Z",
					updatedAt: "2000-01-01T00:00:00.000Z",
					lastTool: "write",
				},
				null,
			),
		);

		const current = await activate(url, repo, "fresh-writer");
		const result = await emit(
			current.handlers,
			"tool_call",
			toolCallEvent("edit", { path: "file.txt" }),
			current.ctx,
		);
		check("stale writer lease does not permanently block the worktree", result === undefined, JSON.stringify(result));
		const lease = await readLease(repo);
		check(
			"stale writer lease is replaced by the fresh session",
			lease.sessionId === "fresh-writer",
			JSON.stringify(lease),
		);
		await shutdown(current);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

async function scenarioCleanRelease(url) {
	const repo = await makeRepo();
	try {
		const first = await activate(url, repo, "writer-a");
		await emit(first.handlers, "tool_call", toolCallEvent("write", { path: "file.txt", content: "x" }), first.ctx);
		check("lease exists before clean shutdown", existsSync(leasePath(repo)), leasePath(repo));
		await shutdown(first);
		check("clean shutdown releases the writer lease", !existsSync(leasePath(repo)), leasePath(repo));

		const second = await activate(url, repo, "writer-b");
		const result = await emit(
			second.handlers,
			"tool_call",
			toolCallEvent("write", { path: "file.txt", content: "y" }),
			second.ctx,
		);
		check("a new session can write after clean release", result === undefined, JSON.stringify(result));
		await shutdown(second);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

async function scenarioSubdirSharesWorktreeRoot(url) {
	const repo = await makeRepo();
	try {
		const subdir = path.join(repo, "nested", "path");
		await fs.mkdir(subdir, { recursive: true });
		const rootSession = await activate(url, repo, "writer-root");
		await emit(
			rootSession.handlers,
			"tool_call",
			toolCallEvent("write", { path: "file.txt", content: "x" }),
			rootSession.ctx,
		);

		const nestedSession = await activate(url, subdir, "writer-nested");
		const blocked = await emit(
			nestedSession.handlers,
			"tool_call",
			toolCallEvent("bash", { command: "touch another.txt" }),
			nestedSession.ctx,
		);
		check(
			"subdirectory session conflicts with the same git worktree root",
			isBlocked(blocked),
			JSON.stringify(blocked),
		);
		check("conflict reason shows the worktree root", blocked?.reason?.includes(repo), blocked?.reason);
		await shutdown(nestedSession);
		await shutdown(rootSession);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

async function scenarioUserBashConflict(url) {
	const repo = await makeRepo();
	try {
		const first = await activate(url, repo, "writer-a");
		await emit(first.handlers, "tool_call", toolCallEvent("write", { path: "file.txt", content: "x" }), first.ctx);

		const second = await activate(url, repo, "writer-b");
		const blocked = await emit(
			second.handlers,
			"user_bash",
			userBashEvent(repo, "touch from-user-bash.txt"),
			second.ctx,
		);
		check(
			"mutating user bash is blocked when another writer owns the worktree",
			blocked?.result?.exitCode !== 0,
			JSON.stringify(blocked),
		);
		check(
			"user bash block output offers worktree fallback",
			/\/worktree open|git_worktree/i.test(blocked?.result?.output ?? ""),
			blocked?.result?.output,
		);
		await shutdown(second);
		await shutdown(first);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

async function main() {
	const previousWriterGuardEnv = process.env.PI_WORKTREE_WRITER_GUARD;
	const { outDir, url } = await buildBundle();
	try {
		delete process.env.PI_WORKTREE_WRITER_GUARD;
		await scenarioDefaultDisabled(url);
		process.env.PI_WORKTREE_WRITER_GUARD = "1";
		await scenarioActiveConflict(url);
		await scenarioStaleLeaseRecovery(url);
		await scenarioCleanRelease(url);
		await scenarioSubdirSharesWorktreeRoot(url);
		await scenarioUserBashConflict(url);
	} finally {
		if (previousWriterGuardEnv === undefined) delete process.env.PI_WORKTREE_WRITER_GUARD;
		else process.env.PI_WORKTREE_WRITER_GUARD = previousWriterGuardEnv;
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.error(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
