import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL_ROOT = path.join(REPO, ".pi", "skills", "pandi-artifact-style");
const TOKENS_PATH = path.join(SKILL_ROOT, "reference", "pandi-tokens.css");
const TEMPLATE_PATH = path.join(SKILL_ROOT, "reference", "template.html");
const SKILL_PATH = path.join(SKILL_ROOT, "SKILL.md");

function parseTokenVariants(css) {
	const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const lightStart = withoutComments.search(/@media[^{]*prefers-color-scheme:\s*light/i);
	const split = lightStart < 0 ? withoutComments.length : lightStart;
	const grab = (block) =>
		Object.fromEntries(
			[...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((match) => [match[1], match[2].trim()]),
		);
	return {
		dark: grab(withoutComments.slice(0, split)),
		light: grab(withoutComments.slice(split)),
	};
}

test("template.html keeps the canonical dark/light custom properties semantically identical", () => {
	const canonical = parseTokenVariants(fs.readFileSync(TOKENS_PATH, "utf8"));
	const template = parseTokenVariants(fs.readFileSync(TEMPLATE_PATH, "utf8"));

	assert.ok(Object.keys(canonical.dark).length > 0, "canonical dark tokens must be non-empty");
	assert.ok(Object.keys(canonical.light).length > 0, "canonical light tokens must be non-empty");
	assert.deepEqual(template, canonical);
});

test("the skill describes semantic custom-property parity rather than byte identity", () => {
	const skill = fs.readFileSync(SKILL_PATH, "utf8");

	assert.match(skill, /custom properties[\s\S]{0,100}semánticamente idéntic/i);
	assert.doesNotMatch(skill, /tokens[^\n.]*byte(?: a byte)?-?idéntic/i);
});
