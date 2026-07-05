import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "publish.yml");

test("publish workflow is tag-gated and verifies before publishing", () => {
	const yml = fs.readFileSync(WORKFLOW, "utf8");
	assert.match(yml, /name:\s*Publish/);
	assert.match(yml, /tags:\s*\["v\*"\]/);
	assert.match(yml, /npm ci/);
	assert.match(yml, /npm test/);
	assert.match(yml, /node scripts\/release-contract\.mjs --expect-tag/);
	assert.match(yml, /node scripts\/publish-npm\.mjs\s*$/m);
	assert.match(yml, /node scripts\/publish-npm\.mjs --publish --provenance/);
	assert.match(yml, /NODE_AUTH_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}/);
	assert.match(yml, /id-token:\s*write/);
});
