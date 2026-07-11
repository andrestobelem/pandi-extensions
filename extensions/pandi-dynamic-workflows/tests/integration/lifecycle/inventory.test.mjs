#!/usr/bin/env node
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();
const NOW = Date.parse("2026-07-01T00:00:00Z");
const hour = 60 * 60 * 1000;

async function loadModule() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-cleanup-inventory",
		relPath: "lifecycle/inventory.ts",
		outName: "inventory.mjs",
	});
	return await import(url);
}

const run = (runId, state, startedAt) => ({
	runId,
	workflow: "drafts/x",
	state,
	startedAt,
	runDir: `/runs/${runId}`,
});
const draft = (name, msAgo) => ({
	name,
	path: `/project/.pi/workflows/drafts/${name}`,
	mtimeMs: NOW - msAgo,
	isFile: true,
	isDirectory: false,
	isSymbolicLink: false,
});
const tmpEntry = (name, msAgo, kind = "file") => ({
	name,
	path: `/project/.pi/tmp/${name}`,
	mtimeMs: NOW - msAgo,
	isFile: kind === "file",
	isDirectory: kind === "dir",
	isSymbolicLink: kind === "symlink",
});
const byId = (items, id) => items.find((item) => item.id === id);
const byPath = (items, filePath) => items.find((item) => item.path === filePath);

async function main() {
	const { classifyRunCleanup, classifyDraftCleanup, classifyTmpCleanup } = await loadModule();
	check("exports classifyRunCleanup", typeof classifyRunCleanup === "function", typeof classifyRunCleanup);
	check("exports classifyDraftCleanup", typeof classifyDraftCleanup === "function", typeof classifyDraftCleanup);
	check("exports classifyTmpCleanup", typeof classifyTmpCleanup === "function", typeof classifyTmpCleanup);

	{
		const runs = [
			run("running", "running", "2026-06-01T00:00:05Z"),
			run("active-failed", "failed", "2026-06-01T00:00:04Z"),
			run("new-completed", "completed", "2026-06-01T00:00:03Z"),
			run("old-failed", "failed", "2026-06-01T00:00:02Z"),
			run("old-cancelled", "cancelled", "2026-06-01T00:00:01Z"),
		];
		const items = classifyRunCleanup(runs, { keep: 1, activeIds: new Set(["active-failed"]) });
		check("running run is kept", byId(items, "running")?.action === "keep", JSON.stringify(items));
		check(
			"active terminal run is kept",
			/activo/.test(byId(items, "active-failed")?.reason ?? ""),
			JSON.stringify(items),
		);
		check(
			"newest terminal run is retained by keep window",
			/retención/.test(byId(items, "new-completed")?.reason ?? ""),
			JSON.stringify(items),
		);
		check(
			"old terminal failed run is deletable",
			byId(items, "old-failed")?.action === "delete",
			JSON.stringify(items),
		);
		check(
			"old terminal cancelled run includes terminal reason",
			byId(items, "old-cancelled")?.action === "delete" &&
				/terminal/.test(byId(items, "old-cancelled")?.reason ?? ""),
			JSON.stringify(items),
		);
	}

	{
		const entries = [
			draft("INDEX.md", 72 * hour),
			draft("used.js", 72 * hour),
			draft("recent.js", 1 * hour),
			draft("unused.js", 72 * hour),
			draft("notes.txt", 72 * hour),
		];
		const runs = [run("r1", "completed", "2026-06-01T00:00:00Z")];
		runs[0].workflow = "drafts/used";
		const items = classifyDraftCleanup(entries, runs, { now: NOW, olderThanMs: 24 * hour });
		check("INDEX.md is always kept", byPath(items, "/project/.pi/workflows/drafts/INDEX.md")?.action === "keep");
		check(
			"referenced draft is kept",
			/referenciado/.test(byPath(items, "/project/.pi/workflows/drafts/used.js")?.reason ?? ""),
			JSON.stringify(items),
		);
		check(
			"recent draft is kept",
			/reciente/.test(byPath(items, "/project/.pi/workflows/drafts/recent.js")?.reason ?? ""),
			JSON.stringify(items),
		);
		check(
			"old unused draft is deletable",
			byPath(items, "/project/.pi/workflows/drafts/unused.js")?.action === "delete",
		);
		check(
			"non-workflow draft-dir file is kept",
			byPath(items, "/project/.pi/workflows/drafts/notes.txt")?.action === "keep",
		);
	}

	{
		const entries = [
			tmpEntry("old.log", 72 * hour),
			tmpEntry("recent.log", 1 * hour),
			tmpEntry("old-link", 72 * hour, "symlink"),
		];
		const items = classifyTmpCleanup(entries, { now: NOW, olderThanMs: 24 * hour });
		check("old tmp file is deletable", byPath(items, "/project/.pi/tmp/old.log")?.action === "delete");
		check("recent tmp file is kept", byPath(items, "/project/.pi/tmp/recent.log")?.action === "keep");
		check(
			"old tmp symlink is deletable as the link only",
			byPath(items, "/project/.pi/tmp/old-link")?.action === "delete" &&
				/symlink viejo/.test(byPath(items, "/project/.pi/tmp/old-link")?.reason ?? ""),
			JSON.stringify(items),
		);
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
