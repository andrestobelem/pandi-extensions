/**
 * Durable test for scripts/report-false-economy.mjs (#49).
 *
 * The script turns dynamic-workflow run artifacts into a retrospective signal table:
 * group by (model × effort × rolePrefix) and recommend `low -> medium` only when
 * a low-effort role has at least two recent false-economy signals.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/false-economy-report.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "report-false-economy.mjs");

const { check, counts } = createChecker();

function writeAgent(runsRoot, runId, fileName, body) {
	const dir = path.join(runsRoot, runId, "agents");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), `${body.trim()}\n`);
}

function writeMetrics(runsRoot, runId, agents) {
	fs.mkdirSync(path.join(runsRoot, runId), { recursive: true });
	fs.writeFileSync(path.join(runsRoot, runId, "metrics.json"), `${JSON.stringify({ agents }, null, 2)}\n`);
}

function groupBy(report, rolePrefix, model, effort) {
	return report.groups.find((g) => g.rolePrefix === rolePrefix && g.model === model && g.effort === effort);
}

function main() {
	check("report-false-economy.mjs exists", fs.existsSync(SCRIPT));
	if (!fs.existsSync(SCRIPT)) return finish();

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "false-economy-report-"));
	const runsRoot = path.join(tmp, "runs");
	const outJson = path.join(tmp, "out.json");
	const outMd = path.join(tmp, "out.md");
	try {
		writeAgent(
			runsRoot,
			"2026-01-01T00-00-00Z-a",
			"0001-scout-1.md",
			`
# scout-1-case

- ok: true
- model: haiku
- thinking: low
- focus: 1 turns, peakInput 10 tok, out 100 tok, tools 0 (0 err), retries 0
- schemaOk: false

## Prompt
schema miss fixture
`,
		);
		writeAgent(
			runsRoot,
			"2026-01-01T00-00-01Z-b",
			"0002-scout-2.md",
			`
# scout-2-case

- ok: true
- model: haiku
- thinking: low
- focus: 1 turns, peakInput 10 tok, out 100 tok, tools 0 (0 err), retries 1
- schemaOk: true

## Prompt
retry fixture
`,
		);
		writeAgent(
			runsRoot,
			"2026-01-01T00-00-02Z-c",
			"0003-review-1.md",
			`
# review-1-file

- ok: true
- model: sonnet
- thinking: medium
- schemaOk: true

## Prompt
metrics fallback fixture
`,
		);
		writeMetrics(runsRoot, "2026-01-01T00-00-02Z-c", [
			{ name: "review-1-file", turns: 4, autoRetries: 0, toolErrors: 0 },
		]);
		writeAgent(
			runsRoot,
			"2026-01-01T00-00-03Z-d",
			"0004-extract-1.md",
			`
# extract-1-list

- ok: true
- model: haiku
- thinking: low
- focus: 1 turns, peakInput 10 tok, out 100 tok, tools 0 (0 err), retries 0
- schemaOk: true

## Prompt
clean fixture
`,
		);

		const res = spawnSync(
			"node",
			[SCRIPT, "--runs-root", runsRoot, "--window", "20", "--out", outMd, "--json", outJson],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		check("report script exits 0", res.status === 0, `exit=${res.status} out=${res.stdout} err=${res.stderr}`);
		check("markdown report was written", fs.existsSync(outMd));
		check("json report was written", fs.existsSync(outJson));
		if (fs.existsSync(outJson)) {
			const report = JSON.parse(fs.readFileSync(outJson, "utf8"));
			check("report scanned four agents", report.records.length === 4, `records=${report.records.length}`);
			const scout = groupBy(report, "scout", "haiku", "low");
			check("haiku/low scout group exists", Boolean(scout));
			check(
				"haiku/low scout with two signals recommends promotion",
				scout?.recommendation === "PROMOTE_LOW_TO_MEDIUM" && scout.windowedSignalCount === 2,
				JSON.stringify(scout),
			);
			const review = groupBy(report, "review", "sonnet", "medium");
			check("sonnet/medium review group exists", Boolean(review));
			check(
				"non-low review with a long-turn signal is WATCH, not promote",
				review?.recommendation === "WATCH" && review.longTurnSignals === 1,
				JSON.stringify(review),
			);
			const extract = groupBy(report, "extract", "haiku", "low");
			check("clean haiku/low extract group is OK", extract?.recommendation === "OK", JSON.stringify(extract));
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	finish();
}

function finish() {
	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
