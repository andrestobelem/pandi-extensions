/**
 * Draft usage index: `/workflow index` writes .pi/workflows/drafts/INDEX.md — a
 * usage table over the draft workflows derived from the runs store — so drafts
 * worth promoting (heavily used, healthy) and stale ones (never run) are visible
 * at a glance without spelunking runs/.
 *
 * Two layers, cheapest level first:
 *  1. Pure: formatDraftUsageIndex(workflows, runs) — filters drafts, aggregates
 *     per-draft run counts (ok/failed), last run + state, sorts by recency with
 *     never-run drafts last, and never leaks non-draft workflows into the table.
 *  2. Command: `/workflow index` (headless) writes the file into the project
 *     drafts dir and the content matches the pure formatter's contract.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/draft-usage-index.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildPresentation() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-draft-index-pure",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "presentation.ts"),
		outName: "presentation.mjs",
		npx: "--no-install",
	});
	return await import(url);
}

async function buildFullExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-draft-index",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
		npx: "--yes",
	});
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, def) => commands.set(name, def),
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands };
}

// mode "tui" so notify() routes to ctx.ui.notify (print mode writes to stdout),
// letting the test observe the command's notification.
function makeCtx(cwd) {
	const notifications = [];
	return {
		notifications,
		mode: "tui",
		hasUI: true,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: (msg, level) => notifications.push({ msg, level }),
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function main() {
	// ---------------------------------------------------------- 1) Pure formatter
	const presentation = await buildPresentation();
	const { formatDraftUsageIndex } = presentation;
	check("pure: formatDraftUsageIndex is exported", typeof formatDraftUsageIndex === "function");
	if (typeof formatDraftUsageIndex === "function") {
		// Short draft names (the caller owns location-based filtering); runs reference
		// drafts by their invocation form `drafts/<name>` (or the bare name).
		const draftNames = ["postmortem", "unused"];
		const runs = [
			{ workflow: "drafts/postmortem", state: "completed", startedAt: "2026-07-03T07:00:00.000Z" },
			{ workflow: "drafts/postmortem", state: "failed", startedAt: "2026-07-02T01:00:00.000Z" },
			{ workflow: "other-workflow", state: "completed", startedAt: "2026-07-01T00:00:00.000Z" },
		];
		const md = formatDraftUsageIndex(draftNames, runs);
		check(
			"pure: renders a markdown table with the usage columns",
			/\| draft \| runs \| ok \| failed \| last run \| last state \|/.test(md),
			md,
		);
		check(
			"pure: aggregates runs per draft (postmortem: 2 runs, 1 ok, 1 failed, last = newest)",
			/\| postmortem \| 2 \| 1 \| 1 \| 2026-07-03T07:00:00\.000Z \| completed \|/.test(md),
			md,
		);
		check("pure: never-run drafts appear with zeroes", /\| unused \| 0 \| 0 \| 0 \| — \| — \|/.test(md), md);
		check("pure: non-draft workflows are excluded", !md.includes("other-workflow"), md);
		check("pure: sorted by recency, never-run last", md.indexOf("| postmortem |") < md.indexOf("| unused |"), md);
		const empty = formatDraftUsageIndex([], []);
		check("pure: no drafts → explicit empty message", /no draft workflows/i.test(empty), empty);
	}

	// ---------------------------------------------------------- 2) /workflow index
	const { url } = await buildFullExtension();
	const mod = await import(url);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-draft-index-"));
	const draftsDir = path.join(project, ".pi", "workflows", "drafts");
	await fs.mkdir(draftsDir, { recursive: true });
	await fs.writeFile(path.join(draftsDir, "postmortem.js"), "export default async function main() { return 1; }\n");
	await fs.writeFile(path.join(draftsDir, "unused.js"), "export default async function main() { return 1; }\n");
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "other-workflow.js"),
		"export default async function main() { return 1; }\n",
	);
	const runsDir = path.join(project, ".pi", "workflows", "runs");
	const writeRun = async (id, workflow, state, startedAt) => {
		const dir = path.join(runsDir, id);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "status.json"),
			JSON.stringify({ workflow, runId: id, runDir: dir, state, startedAt, elapsedMs: 1000, agentCount: 1 }),
		);
	};
	await writeRun("r1-postmortem", "drafts/postmortem", "completed", "2026-07-03T07:00:00.000Z");
	await writeRun("r2-postmortem", "drafts/postmortem", "failed", "2026-07-02T01:00:00.000Z");
	await writeRun("r3-other", "other-workflow", "completed", "2026-07-01T00:00:00.000Z");

	const { pi, commands } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const workflowCommand = commands.get("workflow");
	check("command: /workflow is registered", typeof workflowCommand?.handler === "function");
	const ctx = makeCtx(project);
	await workflowCommand.handler("index", ctx);

	let indexMd = "";
	try {
		indexMd = await fs.readFile(path.join(draftsDir, "INDEX.md"), "utf8");
	} catch {
		// stays empty; checks fail with evidence
	}
	check("command: writes .pi/workflows/drafts/INDEX.md", indexMd.length > 0, JSON.stringify(ctx.notifications));
	check(
		"command: index aggregates the postmortem draft's runs",
		/\| postmortem \| 2 \| 1 \| 1 \| 2026-07-03T07:00:00\.000Z \| completed \|/.test(indexMd),
		indexMd,
	);
	check("command: index lists the never-run draft", /\| unused \| 0 \| 0 \| 0 \|/.test(indexMd), indexMd);
	check("command: non-draft workflows stay out of the index", !indexMd.includes("other-workflow"), indexMd);
	check(
		"command: notifies where the index was written",
		ctx.notifications.some((n) => n.msg?.includes("INDEX.md")),
		JSON.stringify(ctx.notifications),
	);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
