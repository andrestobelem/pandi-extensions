import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	deriveSkillClassification,
	listSkillDirs,
	reportUnclassifiedSkills,
	vendoredByExtension,
} from "../../skill-classification.mjs";

test("listSkillDirs returns sorted directory names only", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-classification-"));
	try {
		fs.mkdirSync(path.join(root, "zeta"));
		fs.mkdirSync(path.join(root, "alpha"));
		fs.writeFileSync(path.join(root, "not-a-dir"), "x");
		assert.deepEqual(listSkillDirs(root), ["alpha", "zeta"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("vendoredByExtension groups and sorts skill ownership", () => {
	assert.deepEqual(
		vendoredByExtension({
			zeta: { vendoredBy: ["ext-b", "ext-a"] },
			alpha: { vendoredBy: ["ext-b"] },
			local: { mirrored: true },
		}),
		{
			"ext-a": ["zeta"],
			"ext-b": ["alpha", "zeta"],
		},
	);
});

test("deriveSkillClassification preserves classified buckets and reports unknown dirs", () => {
	const report = deriveSkillClassification(["alpha", "global", "local", "unknown", "vendored"], {
		vendored: { vendoredBy: ["ext"] },
		global: { global: true, mirrored: true },
		local: { excludeReason: "stays local" },
		alpha: { mirrored: true },
	});

	assert.deepEqual(report.mirrored, ["alpha", "global"]);
	assert.deepEqual(report.global, ["global"]);
	assert.deepEqual(report.vendoredByExtension, { ext: ["vendored"] });
	assert.deepEqual(report.excluded, [{ name: "local", reason: "stays local" }]);
	assert.deepEqual(report.unclassified, ["unknown"]);
	assert.deepEqual(report.optionalClaudeGlobalSkills, ["open-prose"]);
});

test("reportUnclassifiedSkills returns the count without requiring discovery", () => {
	const errors = [];
	const originalError = console.error;
	console.error = (line) => errors.push(line);
	try {
		assert.equal(reportUnclassifiedSkills("unit", { unclassified: ["mystery"] }), 1);
		assert.equal(errors.length, 2);
		assert.match(errors[0], /\[unit\] ✗ unclassified skill: mystery/);
	} finally {
		console.error = originalError;
	}
});
