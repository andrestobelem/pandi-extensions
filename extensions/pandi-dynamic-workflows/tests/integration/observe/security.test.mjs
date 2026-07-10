/**
 * run-report-security — el PRIMER pin para el builder HTML run-report (design record
 * §6.1, run bd039ef9): el contenido del run-dir es UNTRUSTED DATA. Los strings renderizan
 * vía el escaper compartido o, para Markdown de output de agente, vía la allowlist estricta
 * del sanitizer. Los hrefs deben ser relativos + containment-safe, y ningún asset externo
 * http(s) puede aparecer en src/href — con exactamente UNA excepción pineada: el renderer
 * Mermaid del diagrama del run, cargado desde una URL CDN version-pinned con hash
 * Subresource Integrity (así una respuesta CDN comprometida/no coincidente falla cerrada
 * — el browser se niega a ejecutarla — en vez de intercambiar silenciosamente JS arbitrario),
 * inicializado con `securityLevel: "sandbox"` (el diagrama renderiza dentro de un iframe sin
 * acceso a la página padre). Ningún OTRO bloque <script> puede aparecer jamás, y ninguno de
 * los scripts puede interpolar strings originados en modelo (la CDN URL, el integrity hash
 * y la init call son todos literales fijos).
 *
 * Suite de módulo puro: bundlea observe/html.ts standalone (sin imports SDK).
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildBuilder() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-security",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "observe/html.ts"),
		outName: "run-report-html.mjs",
	});
	return await import(url);
}

const SCRIPT_PAYLOAD = "</script><script>alert(1)</script>";
const ATTR_PAYLOAD = '"><img src=x onerror=alert(1)>';
const JS_URL_PAYLOAD = "javascript:alert(1)";
const HTTPS_URL_PAYLOAD = "https://evil.example/pixel.png";

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
				output: {
					text: `**safe markdown**\n\n${SCRIPT_PAYLOAD}\n\n[bad js](${JS_URL_PAYLOAD})\n\n[bad https](${HTTPS_URL_PAYLOAD})\n\n![bad image](${HTTPS_URL_PAYLOAD})\n\n<img src=x onerror=alert(1)>`,
					truncated: false,
				},
				data: { text: `{"x":"${SCRIPT_PAYLOAD}"}`, truncated: false },
				stderrTail: { text: `died ${SCRIPT_PAYLOAD}` },
				// Paths hostiles registrados: el builder debe negarse a linkearlos.
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

	// El escaper cubre los cinco metacharacters en una pasada (contextos text + attribute).
	check(
		"escapeHtml escapes & < > \" '",
		mod.escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;",
		JSON.stringify(mod.escapeHtml(`&<>"'`)),
	);

	const html = mod.buildRunReportHtml(hostileModel());
	check("returns a non-empty HTML document", typeof html === "string" && html.startsWith("<!doctype html>"));

	// 1) Exactamente dos tags <script> en total, ambos literales fijos para el renderer Mermaid
	//    del diagrama del run — la carga CDN version-pinned+SRI-hashed y la init call fija. Ningún otro
	//    <script> puede aparecer jamás, y ninguno embebe strings originados en modelo.
	const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
	check("exactly two <script> blocks (mermaid loader + fixed init)", scriptTags.length === 2, scriptTags.length);
	const mermaidLoaderTag = scriptTags.find((tag) => /\bsrc=/.test(tag));
	check(
		"mermaid loader pinned to an exact version on the CDN",
		!!mermaidLoaderTag &&
			/src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.min\.js"/.test(
				mermaidLoaderTag ?? "",
			),
		mermaidLoaderTag,
	);
	check(
		"mermaid loader carries a Subresource Integrity hash + crossorigin",
		!!mermaidLoaderTag &&
			/integrity="sha384-[A-Za-z0-9+/]+=*"/.test(mermaidLoaderTag ?? "") &&
			/crossorigin="anonymous"/.test(mermaidLoaderTag ?? ""),
	);
	const mermaidInitTag = scriptTags.find((tag) => !/\bsrc=/.test(tag));
	check(
		"mermaid init call locks securityLevel to sandbox (isolated iframe, no parent DOM access)",
		!!mermaidInitTag && /securityLevel\s*:\s*"sandbox"/.test(mermaidInitTag ?? ""),
	);
	check(
		"mermaid init uses base theme with explicit light/dark themeVariables",
		!!mermaidInitTag &&
			/theme\s*:\s*"base"/.test(mermaidInitTag ?? "") &&
			(mermaidInitTag ?? "").includes("themeVariables") &&
			(mermaidInitTag ?? "").includes("prefers-color-scheme: light"),
	);
	check(
		"mermaid init call is a fixed literal (no model-sourced string interpolated)",
		!!mermaidInitTag &&
			!(mermaidInitTag ?? "").includes(ATTR_PAYLOAD) &&
			!(mermaidInitTag ?? "").includes(SCRIPT_PAYLOAD),
	);

	// 2) Los payloads raw nunca aparecen sin escape en ninguna parte.
	check("script payload only escaped", !html.includes(SCRIPT_PAYLOAD));
	check("attr payload only escaped", !html.includes(ATTR_PAYLOAD));
	check("escaped script payload present", html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	// Un handler inline real necesita un contexto de tag RAW (`<tag … on*=`); los payloads escapados
	// (cuyo `<` es `&lt;`) nunca pueden matchear esto, así que pinea solo inyección en contexto tag.
	check("no on*= handler inside a real tag", !/<[a-z][^>]*\son[a-z]+\s*=/i.test(html));

	// 3) Los hrefs hostiles se rechazan: nada absoluto, nada traversal, sin URLs js:.
	check("no javascript: href", !/href\s*=\s*"javascript:/i.test(html));
	check("no parent-traversal href", !/href\s*=\s*"[^"]*\.\.\//.test(html));
	check("no absolute-path href", !/href\s*=\s*"\//.test(html));

	// 4) El output Markdown se renderiza, pero luego se sanitiza por allowlist.
	check("safe Markdown emphasis renders", html.includes("<strong>safe markdown</strong>"));
	check("Markdown sanitizer removes image tags", !/<img\b/i.test(html));
	check("Markdown sanitizer removes onerror inside real tags", !/<[a-z][^>]*\sonerror\s*=/i.test(html));
	check("Markdown sanitizer removes unsafe hrefs", !/href\s*=\s*"(?:javascript:|https?:)/i.test(html));
	check("Markdown sanitizer does not leak external URL payload", !html.includes(HTTPS_URL_PAYLOAD));

	// 5) Self-contained salvo por el único <script src> CDN Mermaid pineado: ningún OTRO asset
	//    externo de red puede aparecer en src/href (en particular, nunca en un href — solo ese
	//    <script src> puede ser externo, y solo hacia esa URL exacta pineada).
	check("no http(s) href anywhere", !/href\s*=\s*"https?:/i.test(html));
	const nonMermaidHttpSrc = (html.match(/\bsrc\s*=\s*"https?:[^"]*"/gi) ?? []).filter(
		(src) => !src.includes("cdn.jsdelivr.net/npm/mermaid@"),
	);
	check(
		"no http(s) src other than the pinned mermaid CDN url",
		nonMermaidHttpSrc.length === 0,
		nonMermaidHttpSrc.join(", "),
	);

	// 5b) El diagrama mismo renderiza nombres de agentes/phase labels hostiles sin filtrar ningún
	//     payload raw — mermaidLabel() quita bracket/quote/angle chars antes de que el string
	//     llegue al div .mermaid, y encima el contenido del div sigue HTML-escaped.
	check("mermaid diagram div is present", html.includes('<div class="mermaid">'));
	check(
		"mermaid diagram source text is also shown as a plain-text fallback",
		/<pre>[\s\S]*flowchart TD[\s\S]*<\/pre>/.test(html),
	);

	// 6) Links relativos limpios siguen funcionando, URL-encoded en contexto attribute.
	check(
		"clean agent artifact link uses static viewer",
		html.includes('href="artifact-viewer.html#artifact-'),
		"expected artifact-viewer href",
	);
	check(
		"space/quote href stays contained in static viewer",
		/href="artifact-viewer\.html#artifact-[^"]*0002%20/.test(html),
	);

	// 7) Tokens Pandi light+dark inline.
	check("dark tokens present", html.includes("--bg: #242526"));
	check("light variant present", html.includes("prefers-color-scheme: light"));

	// 8) Failure nunca es footnote; las clamp notes son visibles y escapadas.
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
