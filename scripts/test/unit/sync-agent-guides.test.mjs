import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { guideMirrorPair, parseCheckOnly, syncAgentGuides } from "../../sync-agent-guides.mjs";

function logs() {
	const lines = [];
	return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

test("sync-agent-guides helpers expose check mode and mirror paths", () => {
	assert.equal(parseCheckOnly(["--check"]), true);
	assert.equal(parseCheckOnly([]), false);
	assert.deepEqual(guideMirrorPair("/repo"), {
		src: path.join("/repo", "AGENTS.md"),
		dst: path.join("/repo", "CLAUDE.md"),
	});
});

test("syncAgentGuides writes CLAUDE.md from AGENTS.md and then reports in sync", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-guides-"));
	try {
		const src = path.join(root, "AGENTS.md");
		const dst = path.join(root, "CLAUDE.md");
		fs.writeFileSync(src, "# guide\n");

		const writeLog = logs();
		assert.deepEqual(await syncAgentGuides({ src, dst, log: writeLog.log, error: writeLog.error }), {
			ok: true,
			wrote: true,
			drift: false,
			missing: false,
		});
		assert.equal(fs.readFileSync(dst, "utf8"), "# guide\n");

		const checkLog = logs();
		assert.deepEqual(await syncAgentGuides({ checkOnly: true, src, dst, log: checkLog.log, error: checkLog.error }), {
			ok: true,
			wrote: false,
			drift: false,
			missing: false,
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncAgentGuides reports check-mode drift without writing", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-guides-"));
	try {
		const src = path.join(root, "AGENTS.md");
		const dst = path.join(root, "CLAUDE.md");
		fs.writeFileSync(src, "# wanted\n");
		fs.writeFileSync(dst, "# stale\n");

		const captured = logs();
		assert.deepEqual(await syncAgentGuides({ checkOnly: true, src, dst, log: captured.log, error: captured.error }), {
			ok: false,
			wrote: false,
			drift: true,
			missing: false,
		});
		assert.equal(fs.readFileSync(dst, "utf8"), "# stale\n");
		assert.match(captured.lines.join("\n"), /CLAUDE\.md differs/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncAgentGuides reports missing source", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-guides-"));
	try {
		const captured = logs();
		assert.deepEqual(
			await syncAgentGuides({
				src: path.join(root, "AGENTS.md"),
				dst: path.join(root, "CLAUDE.md"),
				log: captured.log,
				error: captured.error,
			}),
			{ ok: false, wrote: false, drift: false, missing: true },
		);
		assert.match(captured.lines.join("\n"), /missing source/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
