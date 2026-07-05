import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RELEASING = path.join(REPO, "RELEASING.md");

test("release playbook documents the executable release path", () => {
	const md = fs.readFileSync(RELEASING, "utf8");
	assert.match(md, /^# Release de pandi-extensions/m);
	assert.match(md, /root `package\.json`/);
	assert.match(md, /`v\$\{root\.version\}`/);
	assert.match(md, /node scripts\/release-contract\.mjs --expect-tag/);
	assert.match(md, /node scripts\/publish-npm\.mjs/);
	assert.match(md, /node scripts\/publish-npm\.mjs --publish --provenance/);
	assert.match(md, /`NPM_TOKEN`/);
	assert.match(md, /pi-cante/);
});
