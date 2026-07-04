/**
 * Trust gate for the default web_search extension auto-attach.
 *
 * applyDefaultAgentAccess() auto-attaches the pi-codex-web-search extension resolved from
 * BOTH the global agent dir AND `path.join(ctx.cwd, "node_modules", ...)`. Every other
 * cwd-derived code/config path in this extension is gated behind ctx.isProjectTrusted()
 * (loadProjectPersona), but the cwd web-search entry was NOT — so a malicious cwd could
 * drop node_modules/pi-codex-web-search and get its code loaded as an extension into every
 * subagent. This pins: the cwd entry is attached ONLY when the project is trusted; the
 * global (agent-dir) entry is unaffected.
 *
 * Mutation-free w.r.t. the repo: bundles agent-env-persona.ts and calls the exported
 * function against a throwaway fixture project under the OS temp dir.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/env-persona-websearch-trust.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createChecker,
	REPO_ROOT,
	sdkStub,
	buildExtension as sharedBuildExtension,
} from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

async function main() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-env-persona-trust",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "agent-env-persona.ts"),
		outName: "agent-env-persona.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
	const mod = await import(url);
	const { applyDefaultAgentAccess, DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE } = mod;

	// A throwaway project whose cwd/node_modules contains a droppable web-search package.
	const proj = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-trust-"));
	const pkg = path.join(proj, "node_modules", DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE);
	await fs.mkdir(pkg, { recursive: true });
	await fs.writeFile(path.join(pkg, "index.ts"), "export default function () {}\n");

	const ctxFor = (trusted) => ({ cwd: proj, isProjectTrusted: () => trusted });
	const attaches = (out) => (out.extensions ?? []).some((e) => e.includes(DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE));

	try {
		const untrusted = await applyDefaultAgentAccess(ctxFor(false), {});
		check(
			"UNTRUSTED cwd: cwd/node_modules web-search extension is NOT auto-attached",
			!attaches(untrusted),
			`extensions=${JSON.stringify(untrusted.extensions)}`,
		);

		const trusted = await applyDefaultAgentAccess(ctxFor(true), {});
		check(
			"TRUSTED cwd: cwd/node_modules web-search extension IS auto-attached",
			attaches(trusted),
			`extensions=${JSON.stringify(trusted.extensions)}`,
		);
	} finally {
		await fs.rm(proj, { recursive: true, force: true }).catch(() => {});
	}

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		for (const f of counts.failures) console.error(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
