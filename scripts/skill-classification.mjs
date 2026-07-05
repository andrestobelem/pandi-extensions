import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Override solo para tests: los controles negativos de integración pueden correr contra un árbol
// de skills copiado en vez de mutar el directorio live .pi/skills que otras suites paralelas también inspeccionan.
export const SKILLS_ROOT = resolve(process.env.PANDI_SKILLS_ROOT || join(REPO, ".pi", "skills"));

const OPTIONAL_CLAUDE_GLOBAL_SKILLS = ["open-prose"];

const CLASSIFIED_SKILLS = {
	"init-pandi-extensions": { mirrored: true, global: true },
	"ai-assisted-engineering": { mirrored: true, global: true },
	"modern-software-engineering": { mirrored: true, global: true },
	"empirical-software-design": { mirrored: true },
	"clean-craftsmanship": { mirrored: true },
	"github-project": { mirrored: true },
	"pi-cante-releasing": { mirrored: true },
	ultracode: { vendoredBy: ["pandi-dynamic-workflows"], global: true },
	"deep-research": { vendoredBy: ["pandi-dynamic-workflows"] },
	default: { vendoredBy: ["pandi-dynamic-workflows"] },
	"pandi-artifact-style": { vendoredBy: ["pandi-docs"] },
	"didactic-docs-style": {
		excludeReason: "docs-scaffold helper stays project-local and is not mirrored, vendored, or global",
	},
	"markdownlint-cli2": {
		excludeReason: "external CLI helper stays project-local and is not mirrored, vendored, or global",
	},
	"pandi-prose-style": {
		excludeReason: "local prose style stays project-local and is not mirrored, vendored, or global",
	},
};

const CLASSIFIED_SKILL_NAMES = Object.keys(CLASSIFIED_SKILLS).sort();
const MIRRORED = CLASSIFIED_SKILL_NAMES.filter((name) => CLASSIFIED_SKILLS[name].mirrored);
const GLOBAL = CLASSIFIED_SKILL_NAMES.filter((name) => CLASSIFIED_SKILLS[name].global);
const EXCLUDED = CLASSIFIED_SKILL_NAMES.filter((name) => CLASSIFIED_SKILLS[name].excludeReason).map((name) => ({
	name,
	reason: CLASSIFIED_SKILLS[name].excludeReason,
}));
const VENDORED_BY_EXTENSION = (() => {
	const vendoredByExtension = {};
	for (const name of CLASSIFIED_SKILL_NAMES) {
		for (const ext of CLASSIFIED_SKILLS[name].vendoredBy ?? []) {
			const ownedSkills = vendoredByExtension[ext] ?? [];
			ownedSkills.push(name);
			vendoredByExtension[ext] = ownedSkills;
		}
	}
	for (const skills of Object.values(vendoredByExtension)) skills.sort();
	return vendoredByExtension;
})();

export function discoverSkillClassification() {
	const skillDirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	const unclassified = skillDirs.filter((name) => !CLASSIFIED_SKILLS[name]);

	return {
		mirrored: [...MIRRORED],
		global: [...GLOBAL],
		vendoredByExtension: Object.fromEntries(
			Object.entries(VENDORED_BY_EXTENSION).map(([ext, skills]) => [ext, [...skills]]),
		),
		excluded: EXCLUDED.map(({ name, reason }) => ({ name, reason })),
		unclassified,
		optionalClaudeGlobalSkills: [...OPTIONAL_CLAUDE_GLOBAL_SKILLS],
	};
}

export function reportUnclassifiedSkills(scriptName, report = discoverSkillClassification()) {
	for (const name of report.unclassified) {
		console.error(
			`[${scriptName}] ✗ unclassified skill: ${name} (.pi/skills/${name}/ — classify it in scripts/skill-classification.mjs)`,
		);
	}
	if (report.unclassified.length > 0) {
		console.error(
			`[${scriptName}] ${report.unclassified.length} unclassified skill(s) discovered under .pi/skills — classify or exclude them explicitly.`,
		);
	}
	return report.unclassified.length;
}
