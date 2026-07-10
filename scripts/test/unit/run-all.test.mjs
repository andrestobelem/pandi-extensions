import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "test", "run-all.mjs");
const {
	computeConcurrency,
	discoverSuites,
	formatSuiteContamination,
	hasSuiteContamination,
	isIntegrationSuitePath,
	isRunnerInfluencingPath,
	parseRunnerArgs,
	suiteLabel,
} = await import(pathToFileURL(SCRIPT).href);

function touch(file) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "// test suite\n");
}

function cleanGitEnv(env = process.env) {
	const clean = { ...env };
	for (const key of Object.keys(clean)) {
		if (key.startsWith("GIT_")) delete clean[key];
	}
	return clean;
}

function git(repo, args) {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: cleanGitEnv() });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

function withEnv(vars, fn) {
	const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(vars)) process.env[key] = value;
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("parseRunnerArgs accepts only the documented flags", () => {
	assert.deepEqual(parseRunnerArgs(["--list"]).unknownArgs, []);
	assert.deepEqual(parseRunnerArgs(["--serial", "--bogus", "value"]).unknownArgs, ["--bogus", "value"]);
});

test("computeConcurrency preserves serial, env override, and cpu fallback semantics", () => {
	assert.equal(computeConcurrency(new Set(["--serial"]), { TEST_CONCURRENCY: "8" }, 16), 1);
	assert.equal(computeConcurrency(new Set(), { TEST_CONCURRENCY: "2" }, 16), 2);
	assert.equal(computeConcurrency(new Set(), { TEST_CONCURRENCY: "" }, 8), 4);
	assert.equal(computeConcurrency(new Set(), { TEST_CONCURRENCY: "0" }, 2), 2);
	assert.equal(computeConcurrency(new Set(), { TEST_CONCURRENCY: "-1" }, 8), 1);
});

test("discoverSuites finds integration tests by convention and reports existing ignored drafts", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-all-discovery-"));
	try {
		touch(path.join(root, "extensions", "beta", "tests", "integration", "z.test.mjs"));
		touch(path.join(root, "extensions", "alpha", "tests", "integration", "a.test.mjs"));
		touch(path.join(root, "extensions", "alpha", "tests", "integration", "notes.txt"));
		const ignored = new Set(["extensions/beta/tests/integration/z.test.mjs", "missing.test.mjs"]);

		assert.deepEqual(discoverSuites(root, ignored), {
			suites: ["extensions/alpha/tests/integration/a.test.mjs"],
			unregisteredSuites: [],
			ignoredSuiteFiles: [],
			contaminatingFiles: [],
			ignoredExisting: ["extensions/beta/tests/integration/z.test.mjs"],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSuites ignores inherited Git hook env when probing another root", () => {
	const hookRepo = fs.mkdtempSync(path.join(os.tmpdir(), "run-all-hook-repo-"));
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-all-hook-discovery-"));
	try {
		git(hookRepo, ["init", "--quiet"]);
		touch(path.join(hookRepo, "tracked.test.mjs"));
		git(hookRepo, ["add", "tracked.test.mjs"]);
		touch(path.join(root, "extensions", "alpha", "tests", "integration", "a.test.mjs"));

		withEnv({ GIT_DIR: path.join(hookRepo, ".git"), GIT_WORK_TREE: hookRepo }, () => {
			assert.deepEqual(discoverSuites(root, new Set()), {
				suites: ["extensions/alpha/tests/integration/a.test.mjs"],
				unregisteredSuites: [],
				ignoredSuiteFiles: [],
				contaminatingFiles: [],
				ignoredExisting: [],
			});
		});
	} finally {
		fs.rmSync(hookRepo, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("discoverSuites separates tracked suites from unregistered and ignored contamination", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-all-contamination-"));
	try {
		touch(path.join(root, "extensions", "alpha", "tests", "integration", "tracked.test.mjs"));
		touch(path.join(root, "extensions", "beta", "tests", "integration", "untracked.test.mjs"));
		touch(path.join(root, "extensions", "gamma", "tests", "integration", "ignored.test.mjs"));
		touch(path.join(root, "extensions", "other", "index.ts"));
		touch(path.join(root, "extensions", "draft", "tests", "integration", "draft.test.mjs"));
		const ignored = new Set(["extensions/draft/tests/integration/draft.test.mjs"]);
		const gitState = {
			trackedFiles: new Set(["extensions/alpha/tests/integration/tracked.test.mjs"]),
			untrackedFiles: new Set(["extensions/beta/tests/integration/untracked.test.mjs", "extensions/other/index.ts"]),
			ignoredFiles: new Set(["extensions/gamma/tests/integration/"]),
		};

		assert.deepEqual(discoverSuites(root, ignored, gitState), {
			suites: ["extensions/alpha/tests/integration/tracked.test.mjs"],
			unregisteredSuites: ["extensions/beta/tests/integration/untracked.test.mjs"],
			ignoredSuiteFiles: ["extensions/gamma/tests/integration/ignored.test.mjs"],
			contaminatingFiles: ["extensions/other/index.ts"],
			ignoredExisting: ["extensions/draft/tests/integration/draft.test.mjs"],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("suite contamination report is distinct from suite failures", () => {
	const discovery = {
		suites: ["extensions/alpha/tests/integration/tracked.test.mjs"],
		ignoredExisting: [],
		unregisteredSuites: ["extensions/beta/tests/integration/untracked.test.mjs"],
		ignoredSuiteFiles: ["extensions/gamma/tests/integration/ignored.test.mjs"],
		contaminatingFiles: ["extensions/other/index.ts"],
	};

	assert.equal(hasSuiteContamination(discovery), true);
	const report = formatSuiteContamination(discovery);
	assert.match(report, /ENVIRONMENT CONTAMINATED/);
	assert.match(report, /Unregistered suites/);
	assert.match(report, /Ignored suites/);
	assert.match(report, /Other untracked\/ignored/);
	assert.doesNotMatch(report, /^FAIL /m);
});

test("path matchers pin the runner discovery and contamination conventions", () => {
	assert.equal(isIntegrationSuitePath("extensions/pandi/tests/integration/face.test.mjs"), true);
	assert.equal(isIntegrationSuitePath("extensions/pandi/tests/integration/ultracode/border.test.mjs"), true);
	assert.equal(isIntegrationSuitePath("extensions/pandi/tests/unit/face.test.mjs"), false);
	assert.equal(isIntegrationSuitePath("scripts/test/unit/run-all.test.mjs"), false);
	assert.equal(isRunnerInfluencingPath("extensions/pandi/index.ts"), true);
	assert.equal(isRunnerInfluencingPath("scripts/test/run-all.mjs"), true);
	assert.equal(isRunnerInfluencingPath(".pi/tmp/scratch.mjs"), false);
});

test("discoverSuites finds nested deep-module suites under integration/", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-all-nested-"));
	try {
		touch(path.join(root, "extensions", "alpha", "tests", "integration", "flat.test.mjs"));
		touch(path.join(root, "extensions", "alpha", "tests", "integration", "ultracode", "nested.test.mjs"));
		touch(path.join(root, "extensions", "alpha", "tests", "integration", "fixtures", "not-a-suite.test.mjs"));
		assert.deepEqual(discoverSuites(root, new Set()), {
			suites: [
				"extensions/alpha/tests/integration/flat.test.mjs",
				"extensions/alpha/tests/integration/ultracode/nested.test.mjs",
			],
			unregisteredSuites: [],
			ignoredSuiteFiles: [],
			contaminatingFiles: [],
			ignoredExisting: [],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("suiteLabel matches the runner status precedence", () => {
	assert.equal(suiteLabel({ status: 0, timedOut: true }), "PASS");
	assert.equal(suiteLabel({ status: 1, timedOut: true }), "TIMEOUT");
	assert.equal(suiteLabel({ status: 1, timedOut: false }), "FAIL");
});
