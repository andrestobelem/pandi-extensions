import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RELEASING = path.join(REPO, "RELEASING.md");
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const CURRENT_TAG = `v${ROOT_PKG.version}`;

function bashBlocks(md) {
	const blocks = [];
	const fence = /^```(\w+)?\s*$/;
	let current = null;
	for (const line of md.split("\n")) {
		const match = fence.exec(line);
		if (match) {
			if (current) {
				blocks.push(current);
				current = null;
			} else if (match[1] === "bash") {
				current = [];
			}
			continue;
		}
		if (current) current.push(line);
	}
	return blocks.map((block) => block.map((line) => line.trim()).filter(Boolean));
}

test("release playbook documents the executable release path", () => {
	const md = fs.readFileSync(RELEASING, "utf8");
	const commands = bashBlocks(md).flat();
	assert.match(md, /^# Release de pandi-extensions$/m);
	assert.match(md, /root `package\.json`/);
	assert.match(md, /`v\$\{root\.version\}`/);
	assert.deepEqual(commands.slice(0, 3), [
		"npm run release:flow",
		"npm run release:go",
		`npm run release:ship -- --confirm ${CURRENT_TAG}`,
	]);
	assert.ok(commands.includes("npm run release:prepare:write -- --until-clean"));
	assert.match(md, /--until-clean/);
	assert.match(md, /plan stale falla\s+cerrado/);
	assert.match(md, /`NPM_TOKEN`/);
	assert.match(md, /pi-cante/);
});
