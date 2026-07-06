import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const preCommitHook = fs.readFileSync(path.join(REPO, "scripts", "git-hooks", "pre-commit"), "utf8");

function npmRunTargets(script) {
	return Array.from(script.matchAll(/npm run (?:--silent |-s )?([\w:-]+)/g), (match) => match[1]);
}

test("root package exposes a fast whole-tree quality gate", () => {
	const fast = rootPkg.scripts["test:fast"];
	assert.equal(typeof fast, "string");
	assert.deepEqual(npmRunTargets(fast), ["typecheck", "check", "lint:md", "sync:check:all", "test:unit"]);
	assert.doesNotMatch(fast, /test:integration/);
	assert.doesNotMatch(fast, /npm run test(?:\s|$)/);

	assert.equal(rootPkg.scripts["check:staged"], "npm run -s test:fast");
});

test("full npm test remains the only script that runs integration suites", () => {
	assert.match(rootPkg.scripts.test, /npm run test:integration/);
	assert.doesNotMatch(rootPkg.scripts["test:fast"], /test:integration/);
	assert.doesNotMatch(rootPkg.scripts["check:staged"], /test:integration/);
});

test("pre-commit delegates to the canonical fast gate instead of duplicating it", () => {
	assert.match(preCommitHook, /npm run --silent test:fast \|\| fail "test:fast"/);
	assert.doesNotMatch(preCommitHook, /npm run --silent typecheck/);
	assert.doesNotMatch(preCommitHook, /npm run --silent sync:check:all/);
});
