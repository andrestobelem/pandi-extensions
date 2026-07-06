import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "report-false-economy.mjs");

function writeFile(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function runReport(args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });
}

test("report-false-economy promotes low-effort groups with repeated recent signals", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "false-economy-runs-"));
	try {
		for (const name of ["reviewer-1", "reviewer-2"]) {
			writeFile(
				path.join(root, "run-a", "agents", `${name}.md`),
				`# ${name}\n- ok: true\n- schemaOk: false\n- model: haiku\n- thinking: minimal\n- focus: 4 turns, tools 3 (1 err), retries 1\n`,
			);
		}

		const result = runReport(["--runs-root", root, "--window", "2"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Runs scanned: \*\*1\*\* · agents scanned: \*\*2\*\* · window: \*\*2\*\*/);
		assert.match(
			result.stdout,
			/\| PROMOTE_LOW_TO_MEDIUM \| reviewer \| haiku \| low \| 2 \| 2\/2 \| 2 \| 2 \| 2 \|/,
		);
		assert.match(result.stdout, /### reviewer · haiku · low/);
		assert.match(result.stdout, /run-a · reviewer-2 — schemaOk:false, retries>0, turns>3/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("report-false-economy can write markdown and JSON reports using metrics fallback data", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "false-economy-runs-"));
	try {
		writeFile(
			path.join(root, "run-b", "metrics.json"),
			`${JSON.stringify({ agents: [{ name: "architect: plan", model: "sonnet", thinking: "medium", turns: 2 }] })}\n`,
		);
		writeFile(path.join(root, "run-b", "agents", "architect.md"), "# architect: plan\n- ok: true\n");
		const out = path.join(root, "out", "report.md");
		const json = path.join(root, "out", "report.json");

		const result = runReport(["--runs-root", root, "--out", out, "--json", json]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(
			fs.readFileSync(out, "utf8"),
			/\| OK \| architect \| sonnet \| medium \| 1 \| 0\/1 \| 0 \| 0 \| 0 \|/,
		);
		const parsed = JSON.parse(fs.readFileSync(json, "utf8"));
		assert.equal(parsed.runCount, 1);
		assert.equal(parsed.records.length, 1);
		assert.equal(parsed.groups[0].rolePrefix, "architect");
		assert.equal(parsed.groups[0].recommendation, "OK");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
