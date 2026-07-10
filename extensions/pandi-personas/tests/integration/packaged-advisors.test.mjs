#!/usr/bin/env node
/**
 * Comprueba el contrato real de pandi-personas: la extensión registra las
 * definiciones empaquetadas y Dynamic Workflows conserva la precedencia de una
 * persona del proyecto trusted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PERSONAS_DIR = path.join(REPO_ROOT, "extensions", "pandi-personas");
const DYNAMIC_WORKFLOWS_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const { check, counts } = createChecker();

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const ADVISORS = [
	{ agentType: "andrej-karpathy", skills: ["ai-assisted-engineering", "karpathy-guidelines"] },
	{ agentType: "dave-farley", skills: ["modern-software-engineering"] },
	{ agentType: "kent-beck", skills: ["empirical-software-design"] },
	{ agentType: "uncle-bob", skills: ["clean-craftsmanship"] },
];

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function runtimePersonaSource() {
	for (const rel of ["runtime/agent-env-persona.ts", "agent-env-persona.ts"]) {
		const source = path.join(DYNAMIC_WORKFLOWS_DIR, rel);
		if (fs.existsSync(source)) return source;
	}
	throw new Error("No se encontró el resolver de personas de Dynamic Workflows.");
}

async function loadRuntimePersonaModule() {
	const { url } = await buildExtension({
		name: "pandi-personas-runtime",
		src: runtimePersonaSource(),
		outName: "agent-env-persona.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
	return await loadModule(url);
}

async function loadPackagedPersonasExtension() {
	const { url } = await buildExtension({
		name: "pandi-personas-package",
		src: path.join(PERSONAS_DIR, "index.ts"),
		outName: "index.mjs",
		copyDirs: { personas: path.join(PERSONAS_DIR, "personas") },
	});
	return await loadModule(url);
}

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-packaged-advisors-"));
	try {
		const packagedExtension = await loadPackagedPersonasExtension();
		packagedExtension.default();
		const runtime = await loadRuntimePersonaModule();
		const untrustedCtx = { cwd: tmp, isProjectTrusted: () => false };

		for (const advisor of ADVISORS) {
			const resolved = await runtime.applyPersonaOptions(untrustedCtx, { agentType: advisor.agentType });
			check(
				`packaged '${advisor.agentType}' keeps the read-only tool set`,
				Array.isArray(resolved.tools) && resolved.tools.join(",") === READ_ONLY_TOOLS.join(","),
				JSON.stringify(resolved.tools),
			);
			check(
				`packaged '${advisor.agentType}' enables its explicit skills`,
				resolved.includeSkills === true && JSON.stringify(resolved.skills) === JSON.stringify(advisor.skills),
				JSON.stringify({ includeSkills: resolved.includeSkills, skills: resolved.skills }),
			);
		}

		writeJson(path.join(tmp, ".pi", "personas", "kent-beck.json"), {
			tools: ["read"],
			skills: ["project-skill"],
			includeSkills: true,
			thinking: "medium",
			systemPrompt: "project override",
		});
		const trustedCtx = { cwd: tmp, isProjectTrusted: () => true };
		const overridden = await runtime.applyPersonaOptions(trustedCtx, { agentType: "kent-beck" });
		check(
			"trusted project persona overrides the packaged kent-beck advisor",
			overridden.systemPrompt === "project override",
		);
		check(
			"project override preserves its own skills and tools",
			JSON.stringify(overridden.skills) === JSON.stringify(["project-skill"]) &&
				JSON.stringify(overridden.tools) === JSON.stringify(["read"]),
			JSON.stringify({ skills: overridden.skills, tools: overridden.tools }),
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n  - ${counts.failures.join("\n  - ")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
