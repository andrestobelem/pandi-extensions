import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildPublishPlanDocument } from "../../publish-npm.mjs";
import {
	applyVersionBumps,
	bumpPatch,
	parsePrepareOptions,
	parsePublishPlan,
	planVersionBumps,
	publishPlanToLegacyShape,
} from "../../release-prepare.mjs";

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

test("release-prepare: parse options keeps dry-run as the default", () => {
	assert.deepEqual(parsePrepareOptions([]), {
		write: false,
		publishOutputFile: undefined,
		publishPlanFile: undefined,
	});
	assert.deepEqual(parsePrepareOptions(["--write", "--publish-output", "plan.txt"]), {
		write: true,
		publishOutputFile: "plan.txt",
		publishPlanFile: undefined,
	});
	assert.deepEqual(parsePrepareOptions(["--publish-plan=plan.json"]), {
		write: false,
		publishOutputFile: undefined,
		publishPlanFile: "plan.json",
	});
});

test("release-prepare: parses scoped BUMP? lines from publish dry-run output", () => {
	const plan = parsePublishPlan(`
BUMP?    @pandi-coding-agent/pandi-bg@0.1.5 (published but content differs — bump the version first)
PUBLISH  @pandi-coding-agent/new-one@0.1.0 (version not on npm)

23 workspaces: 1 to publish, 8 unchanged, 1 need a version bump.
`);
	assert.deepEqual(plan.bumps, [{ name: "@pandi-coding-agent/pandi-bg", version: "0.1.5" }]);
	assert.deepEqual(plan.publishes, [{ name: "@pandi-coding-agent/new-one", version: "0.1.0" }]);
});

test("release-prepare: converts JSON publish plan into legacy bump list", () => {
	const legacy = publishPlanToLegacyShape(
		buildPublishPlanDocument([
			{ name: "@pandi-coding-agent/pandi-bg", version: "0.1.5", action: "bump" },
			{ name: "@pandi-coding-agent/pandi-plan", version: "0.1.4", action: "publish" },
		]),
	);
	assert.deepEqual(legacy.bumps, [{ name: "@pandi-coding-agent/pandi-bg", version: "0.1.5" }]);
	assert.deepEqual(legacy.publishes, [{ name: "@pandi-coding-agent/pandi-plan", version: "0.1.4" }]);
});

test("release-prepare: patch-bumps semver versions only", () => {
	assert.equal(bumpPatch("0.3.1"), "0.3.2");
	assert.throws(() => bumpPatch("0.3"), /non-semver/);
});

test("release-prepare: plans root plus only workspaces that need BUMP", () => {
	const plan = planVersionBumps({
		rootPkg: { version: "0.3.1" },
		workspaces: [
			{
				dir: "extensions/pandi-bg",
				file: "extensions/pandi-bg/package.json",
				pkg: { name: "@pandi-coding-agent/pandi-bg", version: "0.1.5" },
			},
			{
				dir: "extensions/pandi-ask",
				file: "extensions/pandi-ask/package.json",
				pkg: { name: "@pandi-coding-agent/pandi-ask", version: "0.1.4" },
			},
		],
		packageNames: ["@pandi-coding-agent/pandi-bg"],
	});
	assert.deepEqual(plan, {
		root: { from: "0.3.1", to: "0.3.2" },
		workspaces: [
			{
				dir: "extensions/pandi-bg",
				file: "extensions/pandi-bg/package.json",
				name: "@pandi-coding-agent/pandi-bg",
				from: "0.1.5",
				to: "0.1.6",
			},
		],
	});
});

test("release-prepare: write mode updates package files, lockfile, and release docs", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-"));
	try {
		writeJson(path.join(root, "package.json"), { name: "suite", version: "0.3.1" });
		writeJson(path.join(root, "extensions", "pandi-bg", "package.json"), {
			name: "@pandi-coding-agent/pandi-bg",
			version: "0.1.5",
		});
		writeJson(path.join(root, "extensions", "pandi-plan", "package.json"), {
			name: "@pandi-coding-agent/pandi-plan",
			version: "0.1.4",
			dependencies: { "@pandi-coding-agent/pandi-bg": "0.1.5" },
		});
		writeJson(path.join(root, "package-lock.json"), {
			name: "suite",
			version: "0.3.1",
			packages: {
				"": { name: "suite", version: "0.3.1" },
				"extensions/pandi-bg": { name: "@pandi-coding-agent/pandi-bg", version: "0.1.5" },
				"extensions/pandi-plan": {
					name: "@pandi-coding-agent/pandi-plan",
					version: "0.1.4",
					dependencies: { "@pandi-coding-agent/pandi-bg": "0.1.5" },
				},
			},
		});
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "setup.md"), "pi install pandi-extensions@v0.3.1\n");
		fs.writeFileSync(path.join(root, "RELEASING.md"), "git tag v0.3.1\n");

		applyVersionBumps(root, {
			root: { from: "0.3.1", to: "0.3.2" },
			workspaces: [
				{
					dir: "extensions/pandi-bg",
					name: "@pandi-coding-agent/pandi-bg",
					from: "0.1.5",
					to: "0.1.6",
				},
			],
		});

		assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.3.2");
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(root, "extensions", "pandi-bg", "package.json"), "utf8")).version,
			"0.1.6",
		);
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(root, "extensions", "pandi-plan", "package.json"), "utf8")).dependencies[
				"@pandi-coding-agent/pandi-bg"
			],
			"0.1.6",
		);
		const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
		assert.equal(lock.version, "0.3.2");
		assert.equal(lock.packages[""].version, "0.3.2");
		assert.equal(lock.packages["extensions/pandi-bg"].version, "0.1.6");
		assert.equal(lock.packages["extensions/pandi-plan"].dependencies["@pandi-coding-agent/pandi-bg"], "0.1.6");
		assert.match(fs.readFileSync(path.join(root, "docs", "setup.md"), "utf8"), /v0\.3\.2/);
		assert.match(fs.readFileSync(path.join(root, "RELEASING.md"), "utf8"), /v0\.3\.2/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
