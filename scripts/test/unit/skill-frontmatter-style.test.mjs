import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = path.join(REPO, ".pi", "skills");
const CLAUDE_SKILLS = path.join(REPO, ".claude", "skills");

function frontmatterFor(skill) {
	return skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
}

function descriptionFrom(frontmatter) {
	const inlineDescription = frontmatter.match(/^description: (\S.*)$/mu)?.[1];
	const wrappedDescription = frontmatter.match(/^description:\n((?: {2}\S.*(?:\n|$))+)/mu)?.[1];
	const lines = inlineDescription
		? [inlineDescription]
		: wrappedDescription
				?.split("\n")
				.filter(Boolean)
				.map((line) => line.trim());
	return { description: lines?.join(" "), inlineDescription, wrappedDescription };
}

function skillDirs(root) {
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

function canonicalSkills() {
	return skillDirs(SKILLS);
}

test("canonical skill descriptions use concise plain YAML", () => {
	for (const name of canonicalSkills()) {
		const skill = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
		const frontmatter = frontmatterFor(skill);
		assert.ok(frontmatter, `${name}: missing YAML frontmatter`);
		assert.match(frontmatter, new RegExp(`^name: ${name}$`, "mu"), `${name}: name must match its directory`);
		assert.doesNotMatch(frontmatter, /^# prettier-ignore$/mu, `${name}: descriptions must be formatted normally`);

		const { description, inlineDescription, wrappedDescription } = descriptionFrom(frontmatter);
		assert.ok(
			inlineDescription || wrappedDescription,
			`${name}: description must be plain YAML on one line or indented across several lines`,
		);

		assert.doesNotMatch(description, /^[>|"']/u, `${name}: description must not use block markers or quotes`);
		assert.doesNotMatch(description, /:\s/u, `${name}: plain descriptions cannot contain a colon followed by space`);
		assert.doesNotMatch(description, /\s#/u, `${name}: plain descriptions cannot contain an unescaped YAML comment`);
		assert.match(description, /^\p{L}+[áéíóú](?:\s|$)/iu, `${name}: description must start with an action`);

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

test("legacy default routing stays explicit-only", () => {
	const skill = fs.readFileSync(path.join(SKILLS, "default", "SKILL.md"), "utf8");
	assert.match(frontmatterFor(skill), /^disable-model-invocation: true$/mu);
});

test("model-invoked descriptions are unique within each host", () => {
	for (const root of [SKILLS, CLAUDE_SKILLS]) {
		const owners = new Map();
		for (const name of skillDirs(root)) {
			const skill = fs.readFileSync(path.join(root, name, "SKILL.md"), "utf8");
			const frontmatter = frontmatterFor(skill);
			assert.ok(frontmatter, `${name}: missing YAML frontmatter`);
			if (/^disable-model-invocation: true$/mu.test(frontmatter)) continue;
			const { description } = descriptionFrom(frontmatter);
			assert.ok(description, `${name}: missing model-visible description`);
			assert.equal(
				owners.get(description),
				undefined,
				`${path.relative(REPO, root)}: ${name} duplicates the model-visible description of ${owners.get(description)}`,
			);
			owners.set(description, name);
		}
	}
});

test("skill factory follows the canonical description contract", () => {
	const factory = fs.readFileSync(path.join(REPO, ".pi", "workflows", "skill-factory.js"), "utf8");

	assert.doesNotMatch(factory, /description:\s*[>|][+-]?/u, "skill-factory must require plain YAML descriptions");
	assert.doesNotMatch(factory, /tercera persona/u, "skill-factory must require imperative descriptions");
	assert.doesNotMatch(
		factory,
		/estructura del cuerpo[\s\S]{0,500}Use this skill when/u,
		"skill-factory must keep invocation cases in frontmatter",
	);
	assert.match(factory, /En 30 segundos/u, "skill-factory must require the canonical first H2");
	assert.match(factory, /120 caracteres/u, "skill-factory must enforce the canonical line length");
});
