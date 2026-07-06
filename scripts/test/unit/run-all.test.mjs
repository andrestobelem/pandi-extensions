import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "test", "run-all.mjs");
const { computeConcurrency, discoverSuites, parseRunnerArgs, suiteLabel } = await import(pathToFileURL(SCRIPT).href);

function touch(file) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "// test suite\n");
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
			ignoredExisting: ["extensions/beta/tests/integration/z.test.mjs"],
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
