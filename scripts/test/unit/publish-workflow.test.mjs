import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "publish.yml");

function runCommands(yml) {
	const commands = [];
	const lines = yml.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const step = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
		if (step === "run: |") {
			const indent = line.indexOf("run:");
			const block = [];
			for (i += 1; i < lines.length; i++) {
				const next = lines[i];
				if (next.trim() && next.search(/\S/) <= indent) {
					i -= 1;
					break;
				}
				block.push(next.slice(indent + 2));
			}
			commands.push(block.join("\n").trim());
		} else if (step.startsWith("run: ")) {
			commands.push(step.slice("run: ".length));
		}
	}
	return commands;
}

test("publish workflow is tag-gated and verifies before publishing", () => {
	const yml = fs.readFileSync(WORKFLOW, "utf8");
	const commands = runCommands(yml);
	assert.match(yml, /^name:\s*Publish$/m);
	assert.match(yml, /^\s+tags:\s*\["v\*"\]$/m);
	assert.ok(commands.includes("npm ci"));
	assert.ok(commands.includes("npm test"));
	assert.ok(commands.some((command) => command.includes("node scripts/release-contract.mjs --expect-tag")));
	assert.ok(commands.includes("node scripts/publish-npm.mjs"));
	assert.ok(commands.includes("node scripts/publish-npm.mjs --publish --provenance"));
	assert.ok(commands.indexOf("npm test") < commands.indexOf("node scripts/publish-npm.mjs --publish --provenance"));
	assert.match(yml, /^\s+NODE_AUTH_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}$/m);
	assert.match(yml, /^\s+id-token:\s*write$/m);
});
