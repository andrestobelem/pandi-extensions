/**
 * Este gate valida inventario, visibilidad y diseño del corpus. No inventa un router
 * léxico: la selección semántica se forward-testea con prompts frescos en el host/modelo real.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = path.join(REPO, ".pi", "skills");
const CASES_PATH = path.join(REPO, "scripts", "test", "unit", "fixtures", "skill-routing-cases.json");

function occurrences(text, needle) {
	return text.split(needle).length - 1;
}

test("Pi loads the canonical skill inventory without diagnostics", () => {
	const { skills, diagnostics } = loadSkillsFromDir({ dir: SKILLS, source: "routing-test" });
	assert.deepEqual(diagnostics, []);
	assert.equal(skills.length, 17);
	assert.deepEqual(
		skills.filter((skill) => skill.disableModelInvocation).map((skill) => skill.name),
		["default"],
	);

	const prompt = formatSkillsForPrompt(skills);
	for (const skill of skills) {
		const expectedCount = skill.disableModelInvocation ? 0 : 1;
		assert.equal(
			occurrences(prompt, `<name>${skill.name}</name>`),
			expectedCount,
			`${skill.name}: unexpected model-visible count`,
		);
	}
});

test("routing corpus covers positive, negative, and collision cases", () => {
	const corpus = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
	const { skills } = loadSkillsFromDir({ dir: SKILLS, source: "routing-test" });
	const known = new Set(skills.map((skill) => skill.name));
	const modelInvoked = skills.filter((skill) => !skill.disableModelInvocation).map((skill) => skill.name);
	const ids = new Set();
	const prompts = new Set();
	const expectedCoverage = new Set();
	const forbiddenCoverage = new Set();
	const kinds = new Set();

	assert.equal(corpus.version, 1);
	assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);
	for (const evalCase of corpus.cases) {
		assert.ok(!ids.has(evalCase.id), `duplicate case id: ${evalCase.id}`);
		assert.ok(!prompts.has(evalCase.prompt), `duplicate case prompt: ${evalCase.prompt}`);
		ids.add(evalCase.id);
		prompts.add(evalCase.prompt);
		kinds.add(evalCase.kind);
		assert.ok(["should_trigger", "should_not_trigger", "collision"].includes(evalCase.kind));
		assert.ok(Array.isArray(evalCase.expected) && Array.isArray(evalCase.forbidden));
		assert.equal(
			evalCase.expected.filter((name) => evalCase.forbidden.includes(name)).length,
			0,
			`${evalCase.id}: expected and forbidden overlap`,
		);
		for (const name of [...evalCase.expected, ...evalCase.forbidden]) {
			assert.ok(known.has(name), `${evalCase.id}: unknown skill ${name}`);
		}
		for (const name of evalCase.expected) expectedCoverage.add(name);
		for (const name of evalCase.forbidden) forbiddenCoverage.add(name);
		if (evalCase.kind === "collision") {
			assert.ok(evalCase.expected.length > 0, `${evalCase.id}: collision needs a winner`);
			assert.ok(evalCase.forbidden.length > 0, `${evalCase.id}: collision needs a forbidden competitor`);
		}
	}

	assert.deepEqual([...kinds].sort(), ["collision", "should_not_trigger", "should_trigger"]);
	for (const name of modelInvoked) {
		assert.ok(expectedCoverage.has(name), `${name}: missing should-trigger coverage`);
		assert.ok(forbiddenCoverage.has(name), `${name}: missing should-not-trigger coverage`);
	}
});
