#!/usr/bin/env node
/**
 * run-report-markdown — fija el renderer sanitizado de fragments Markdown del issue #30.
 * El Markdown de output de agente puede convertirse en HTML, pero solo a través de la allowlist
 * del report: HTML raw, tags script/image, URLs externas, schemes, paths absolutos y links de
 * traversal al parent no deben sobrevivir como HTML ejecutable/linkeable.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function buildRenderer() {
	const { url } = await sharedBuildExtension({
		name: "pi-run-report-markdown",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "run-report-markdown.ts"),
		outName: "run-report-markdown.mjs",
	});
	return await import(url);
}

async function main() {
	const mod = await buildRenderer();
	check("renderRunReportMarkdown exported", typeof mod.renderRunReportMarkdown === "function");

	const safe = mod.renderRunReportMarkdown(`## Result

**bold** and *em*.

- one
- two

| a | b |
|---|---|
| 1 | 2 |

\`inline\`

\`\`\`js
<script>alert(1)</script>
\`\`\`

[artifact](agents/0001-worker.md)
`);
	check("headings render", /<h2>Result<\/h2>/.test(safe));
	check("emphasis renders", safe.includes("<strong>bold</strong>") && safe.includes("<em>em</em>"));
	check("lists render", safe.includes("<li>one</li>") && safe.includes("<li>two</li>"));
	check("tables render", safe.includes("<table>") && safe.includes("<td>2</td>"));
	check("code fence escaped", safe.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	check("safe relative link kept", safe.includes('href="agents/0001-worker.md"'));

	const hostile = mod.renderRunReportMarkdown(`raw html: <img src=x onerror=alert(1)>

<script>alert(1)</script>

[bad js](javascript:alert(1))
[bad data](data:text/html,pwn)
[bad external](https://evil.example/x)
[bad absolute](/etc/passwd)
[bad parent](../secret.md)
![bad image](https://evil.example/pixel.png)
[anchor](#local-anchor)
`);
	check("no script tag", !/<script\b/i.test(hostile));
	check("no image tag", !/<img\b/i.test(hostile));
	check("no event handler inside a real tag", !/<[a-z][^>]*\sonerror\s*=/i.test(hostile));
	check("no javascript href", !/href="javascript:/i.test(hostile));
	check("no data href", !/href="data:/i.test(hostile));
	check("no external href", !/href="https?:/i.test(hostile));
	check("external URL payload not leaked", !hostile.includes("https://evil.example"));
	check("absolute/parent links not linked", !/href="(?:\/|\.\.)/.test(hostile));
	check("safe anchor kept", hostile.includes('href="#local-anchor"'));

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
