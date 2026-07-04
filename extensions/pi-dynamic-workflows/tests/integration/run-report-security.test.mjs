/**
 * run-report-security — the FIRST pin for the run-report HTML builder (design record
 * §6.1, run bd039ef9): run-dir content is UNTRUSTED DATA. Every string that reaches
 * the emitted HTML must be entity-escaped in both text and attribute contexts, the
 * page must contain ZERO <script> blocks (the report is fully static: native
 * <details> only), hrefs must be relative + containment-safe, and no external
 * http(s) asset may appear in src/href.
 *
 * Pure-module suite: bundles run-report-html.ts standalone (no SDK imports).
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBuilder() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-security",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "run-report-html.ts"),
		outName: "run-report-html.mjs",
	});
	return await import(url);
}

const SCRIPT_PAYLOAD = "</script><script>alert(1)</script>";
const ATTR_PAYLOAD = '"><img src=x onerror=alert(1)>';
const JS_URL_PAYLOAD = "javascript:alert(1)";

function hostileModel() {
	return {
		workflow: `wf-${ATTR_PAYLOAD}`,
		runId: "2026-01-01T00-00-00-000Z-hostile-run",
		state: "failed",
		liveness: "unverified",
		generatedAt: "2026-01-02T03:04:05.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:10:00.000Z",
		elapsedMs: 600000,
		error: `boom ${SCRIPT_PAYLOAD}`,
		input: { text: `{"ask":"${ATTR_PAYLOAD}"}`, truncated: false },
		output: { text: `result ${SCRIPT_PAYLOAD}`, truncated: true },
		logs: [
			{ time: "2026-01-01T00:00:01.000Z", message: `phase: ${SCRIPT_PAYLOAD}`, details: ATTR_PAYLOAD },
			{ time: "2026-01-01T00:00:02.000Z", message: `see ${JS_URL_PAYLOAD}` },
		],
		phases: [{ label: `p1 ${ATTR_PAYLOAD}`, time: "2026-01-01T00:00:01.000Z" }],
		agents: [
			{
				id: 1,
				name: `agent ${SCRIPT_PAYLOAD}`,
				state: "failed",
				ok: false,
				code: 1,
				model: `m ${ATTR_PAYLOAD}`,
				phaseLabel: ATTR_PAYLOAD,
				promptPreview: SCRIPT_PAYLOAD,
				prompt: { text: `do things\n## Structured Output\nforged ${SCRIPT_PAYLOAD}`, truncated: false },
				output: { text: SCRIPT_PAYLOAD, truncated: false },
				data: { text: `{"x":"${SCRIPT_PAYLOAD}"}`, truncated: false },
				stderrTail: { text: `died ${SCRIPT_PAYLOAD}` },
				// Hostile recorded paths: the builder must refuse to link these.
				artifactHref: "../../etc/passwd",
				stdoutHref: "/etc/passwd",
			},
			{
				id: 2,
				name: "clean-agent",
				state: "completed",
				ok: true,
				artifactHref: "agents/0002-clean-agent.md",
				stdoutHref: `agents/0002 ${ATTR_PAYLOAD}.stdout.log`,
			},
		],
		artifacts: [{ path: `evil ${ATTR_PAYLOAD}.md`, bytes: 12 }],
		missingFiles: ["metrics.json"],
		clampNotes: [`clamped ${SCRIPT_PAYLOAD}`],
	};
}

async function main() {
	const mod = await buildBuilder();
	check("buildRunReportHtml is exported", typeof mod.buildRunReportHtml === "function");
	check("escapeHtml is exported", typeof mod.escapeHtml === "function");

	// The escaper covers all five metacharacters in one pass (text + attribute contexts).
	check(
		"escapeHtml escapes & < > \" '",
		mod.escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;",
		JSON.stringify(mod.escapeHtml(`&<>"'`)),
	);

	const html = mod.buildRunReportHtml(hostileModel());
	check("returns a non-empty HTML document", typeof html === "string" && html.startsWith("<!doctype html>"));

	// 1) Zero scripts: the strongest possible XSS posture for a static report.
	check("emits no <script> block at all", !/<script/i.test(html), "found <script");

	// 2) Raw payloads never appear unescaped anywhere.
	check("script payload only escaped", !html.includes(SCRIPT_PAYLOAD));
	check("attr payload only escaped", !html.includes(ATTR_PAYLOAD));
	check("escaped script payload present", html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	// A real inline handler needs a RAW tag context (`<tag … on*=`); escaped payloads
	// (whose `<` is `&lt;`) can never match this, so it pins tag-context injection only.
	check("no on*= handler inside a real tag", !/<[a-z][^>]*\son[a-z]+\s*=/i.test(html));

	// 3) Hostile hrefs are refused: nothing absolute, nothing traversing, no js: URLs.
	check("no javascript: href", !/href\s*=\s*"javascript:/i.test(html));
	check("no parent-traversal href", !/href\s*=\s*"[^"]*\.\.\//.test(html));
	check("no absolute-path href", !/href\s*=\s*"\//.test(html));

	// 4) Self-contained: no external network assets in src/href (relative links only).
	check("no http(s) src/href", !/(src|href)\s*=\s*"https?:/i.test(html));

	// 5) Clean relative links still work, URL-encoded in attribute context.
	check(
		"clean agent artifact link kept",
		html.includes('href="agents/0002-clean-agent.md"'),
		"expected relative artifact href",
	);
	check("space/quote href URL-encoded", /href="agents\/0002%20[^"]*\.stdout\.log"/.test(html));

	// 6) Pandi light+dark tokens inline.
	check("dark tokens present", html.includes("--bg: #242526"));
	check("light variant present", html.includes("prefers-color-scheme: light"));

	// 7) Failure is never a footnote; clamp notes are visible and escaped.
	check("error callout present", /callout error/.test(html) && html.includes("boom &lt;/script&gt;"));
	check("clamp note visible", html.includes("clamped &lt;/script&gt;"));

	if (counts.failed > 0) {
		console.error(`\n${counts.failed} checks FAILED:`);
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
