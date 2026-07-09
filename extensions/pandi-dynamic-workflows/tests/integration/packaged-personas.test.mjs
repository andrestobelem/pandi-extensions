#!/usr/bin/env node
/**
 * Verifica que pandi-dynamic-workflows pueda resolver personas empaquetadas por
 * extensiones como pandi-personas, sin perder la precedencia de .pi/personas.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXT_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
const { check, counts } = createChecker();

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

async function loadPersonaModule() {
	const { url } = await buildExtension({
		name: "pi-dw-packaged-personas",
		src: path.join(EXT_DIR, "agent-env-persona.ts"),
		outName: "agent-env-persona.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
	return await loadModule(url);
}

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-personas-"));
	try {
		const packagePersonas = path.join(tmp, "package-personas");
		writeJson(path.join(packagePersonas, "advisor-x.json"), {
			tools: ["read", "grep", "find", "ls"],
			thinking: "high",
			systemPrompt: "packaged persona",
		});
		const mod = await loadPersonaModule();
		mod.registerPersonaDirectory(packagePersonas);

		const untrustedCtx = { cwd: tmp, isProjectTrusted: () => false };
		const packaged = await mod.applyPersonaOptions(untrustedCtx, { agentType: "advisor-x", timeoutMs: 123 });
		check("packaged persona resolves when no project persona exists", packaged.systemPrompt === "packaged persona");
		check("explicit options still win over packaged persona", packaged.timeoutMs === 123, JSON.stringify(packaged));

		writeJson(path.join(tmp, ".pi", "personas", "advisor-x.json"), {
			tools: ["read", "grep", "find", "ls"],
			thinking: "medium",
			systemPrompt: "project persona",
		});
		const trustedCtx = { cwd: tmp, isProjectTrusted: () => true };
		const project = await mod.applyPersonaOptions(trustedCtx, { agentType: "advisor-x" });
		check("trusted project persona overrides packaged persona", project.systemPrompt === "project persona");
		check("project persona keeps its own options", project.thinking === "medium", JSON.stringify(project));
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
