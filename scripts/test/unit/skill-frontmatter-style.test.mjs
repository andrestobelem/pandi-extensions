import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = path.join(REPO, ".pi", "skills");

function canonicalSkills() {
	return fs
		.readdirSync(SKILLS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

test("canonical skill descriptions use concise plain YAML", () => {
	for (const name of canonicalSkills()) {
		const skill = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
		const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
		assert.ok(frontmatter, `${name}: missing YAML frontmatter`);
		assert.match(frontmatter, new RegExp(`^name: ${name}$`, "mu"), `${name}: name must match its directory`);
		assert.doesNotMatch(frontmatter, /^# prettier-ignore$/mu, `${name}: descriptions must be formatted normally`);

		const inlineDescription = frontmatter.match(/^description: (\S.*)$/mu)?.[1];
		const wrappedDescription = frontmatter.match(/^description:\n((?: {2}\S.*(?:\n|$))+)/mu)?.[1];
		assert.ok(
			inlineDescription || wrappedDescription,
			`${name}: description must be plain YAML on one line or indented across several lines`,
		);

		const descriptionLines = inlineDescription
			? [inlineDescription]
			: wrappedDescription
					.split("\n")
					.filter(Boolean)
					.map((line) => line.trim());
		const description = descriptionLines.join(" ");
		assert.doesNotMatch(description, /^[>|"']/u, `${name}: description must not use block markers or quotes`);
		assert.doesNotMatch(description, /:\s/u, `${name}: plain descriptions cannot contain a colon followed by space`);
		assert.doesNotMatch(description, /\s#/u, `${name}: plain descriptions cannot contain an unescaped YAML comment`);

		const sourceLines = inlineDescription
			? [`description: ${inlineDescription}`]
			: wrappedDescription.split("\n").filter(Boolean);
		for (const line of sourceLines) {
			assert.ok(line.length <= 120, `${name}: description line has ${line.length} characters; maximum is 120`);
		}

		const words = description.split(/\s+/u).length;
		assert.ok(words <= 60, `${name}: description has ${words} words; maximum is 60`);
	}
});
