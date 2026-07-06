#!/usr/bin/env node
/**
 * End-to-end command contract for the non-run cleanup targets owned by
 * pandi-dynamic-workflows: stale drafts and .pi/tmp scratch.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildExtension, createChecker, REPO_ROOT, sdkStub } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();
const oldDate = new Date("2026-06-01T00:00:00Z");

async function loadHandlers() {
	const { url } = await buildExtension({
		name: "pi-dwf-cleanup-command-targets",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "command-handlers.ts"),
		outName: "command-handlers.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return await import(url);
}

function makeCtx(cwd) {
	const notifications = [];
	return {
		notifications,
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, value) => value },
			notify: (msg, level) => notifications.push({ msg, level }),
			setStatus: () => {},
			setWidget: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function captureConsole(fn) {
	const out = [];
	const err = [];
	const log = console.log;
	const error = console.error;
	console.log = (...args) => out.push(args.join(" "));
	console.error = (...args) => err.push(args.join(" "));
	try {
		await fn();
	} finally {
		console.log = log;
		console.error = error;
	}
	return { out, err };
}

async function writeFile(file, content = "x\n") {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content, "utf8");
	await fs.utimes(file, oldDate, oldDate);
}

async function exists(file) {
	return await fs.stat(file).then(
		() => true,
		() => false,
	);
}

async function main() {
	const { handleWorkflowCommand } = await loadHandlers();
	check("exports handleWorkflowCommand", typeof handleWorkflowCommand === "function", typeof handleWorkflowCommand);
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-cleanup-targets-"));
	try {
		const ctx = makeCtx(project);
		const pi = { exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }) };
		const draftsDir = path.join(project, ".pi", "workflows", "drafts");
		const runsDir = path.join(project, ".pi", "workflows", "runs");
		const tmpDir = path.join(project, ".pi", "tmp");
		const unusedDraft = path.join(draftsDir, "unused.js");
		const usedDraft = path.join(draftsDir, "used.js");
		const index = path.join(draftsDir, "INDEX.md");
		const oldTmp = path.join(tmpDir, "old.log");
		const recentTmp = path.join(tmpDir, "recent.log");
		await writeFile(unusedDraft, "export default async function main() {}\n");
		await writeFile(usedDraft, "export default async function main() {}\n");
		await writeFile(index, "# index\n");
		await writeFile(oldTmp, "old\n");
		await fs.mkdir(path.dirname(recentTmp), { recursive: true });
		await fs.writeFile(recentTmp, "recent\n", "utf8");
		const runDir = path.join(runsDir, "r-used");
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(
			path.join(runDir, "status.json"),
			JSON.stringify({
				workflow: "drafts/used",
				scope: "project",
				file: usedDraft,
				runId: "r-used",
				runDir,
				state: "completed",
				startedAt: "2026-06-01T00:00:00.000Z",
				updatedAt: "2026-06-01T00:00:00.000Z",
				elapsedMs: 1000,
				agentCount: 0,
				logs: [],
			}),
			"utf8",
		);

		const dry = await captureConsole(() =>
			handleWorkflowCommand(pi, "cleanup all --dry-run --older-than=1h --keep=0", ctx),
		);
		const dryText = dry.out.join("\n");
		check(
			"dry-run includes old unused draft",
			dryText.includes("drafts delete") && dryText.includes("unused.js"),
			dryText,
		);
		check(
			"dry-run explains referenced draft keep",
			dryText.includes("used.js") && dryText.includes("referenced"),
			dryText,
		);
		check("dry-run includes old tmp file", dryText.includes("tmp delete") && dryText.includes("old.log"), dryText);
		check("dry-run explains recent tmp keep", dryText.includes("recent.log") && dryText.includes("recent"), dryText);
		check("dry-run keeps files", (await exists(unusedDraft)) && (await exists(oldTmp)), dryText);

		await handleWorkflowCommand(pi, "cleanup drafts --yes --older-than=1h", ctx);
		check("draft cleanup --yes deletes old unused draft", !(await exists(unusedDraft)));
		check("draft cleanup --yes keeps referenced draft", await exists(usedDraft));
		check("draft cleanup --yes keeps INDEX.md", await exists(index));
		await handleWorkflowCommand(pi, "cleanup drafts --yes --older-than=1h", ctx);
		check("draft cleanup --yes is idempotent", (await exists(usedDraft)) && (await exists(index)));

		await handleWorkflowCommand(pi, "cleanup tmp --yes --older-than=1h", ctx);
		check("tmp cleanup --yes deletes old tmp", !(await exists(oldTmp)));
		check("tmp cleanup --yes keeps recent tmp", await exists(recentTmp));
		await handleWorkflowCommand(pi, "cleanup tmp --yes --older-than=1h", ctx);
		check("tmp cleanup --yes is idempotent", !(await exists(oldTmp)) && (await exists(recentTmp)));
	} finally {
		await fs.rm(project, { recursive: true, force: true }).catch(() => {});
	}

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
