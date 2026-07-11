import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = path.join(REPO, ".pi", "skills");

test("every canonical skill opens its body with a 30-second orientation", () => {
	for (const entry of fs.readdirSync(SKILLS, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skill = fs.readFileSync(path.join(SKILLS, entry.name, "SKILL.md"), "utf8");
		const firstSection = skill.match(/^## (.+)$/mu)?.[1];
		assert.equal(firstSection, "En 30 segundos", `${entry.name}: first H2 must orient the agent in 30 seconds`);
	}
});
