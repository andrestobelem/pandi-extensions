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
	"md-to-html": { vendoredBy: ["pandi-docs"] },
	"sync-doc-mirrors": { vendoredBy: ["pandi-docs"] },
	"kitty-remote-control": { vendoredBy: ["pandi-kitty"] },
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

export function listSkillDirs(skillsRoot = SKILLS_ROOT) {
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

export function vendoredByExtension(classifiedSkills = CLASSIFIED_SKILLS) {
	const ownedByExtension = {};
	for (const name of Object.keys(classifiedSkills).sort()) {
		for (const ext of classifiedSkills[name].vendoredBy ?? []) {
			const ownedSkills = ownedByExtension[ext] ?? [];
			ownedSkills.push(name);
			ownedByExtension[ext] = ownedSkills;
		}
	}
	for (const skills of Object.values(ownedByExtension)) skills.sort();
	return ownedByExtension;
}

export function deriveSkillClassification(skillDirs, classifiedSkills = CLASSIFIED_SKILLS) {
	const classifiedNames = Object.keys(classifiedSkills).sort();
	return {
		mirrored: classifiedNames.filter((name) => classifiedSkills[name].mirrored),
		global: classifiedNames.filter((name) => classifiedSkills[name].global),
		vendoredByExtension: Object.fromEntries(
			Object.entries(vendoredByExtension(classifiedSkills)).map(([ext, skills]) => [ext, [...skills]]),
		),
		excluded: classifiedNames
			.filter((name) => classifiedSkills[name].excludeReason)
			.map((name) => ({ name, reason: classifiedSkills[name].excludeReason })),
		unclassified: skillDirs.filter((name) => !classifiedSkills[name]),
		optionalClaudeGlobalSkills: [...OPTIONAL_CLAUDE_GLOBAL_SKILLS],
	};
}

export function discoverSkillClassification(skillsRoot = SKILLS_ROOT) {
	return deriveSkillClassification(listSkillDirs(skillsRoot));
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
