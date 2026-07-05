/**
 * artifact-client-security — pins issue #33: the pre-launch preview client
 * (.claude/scripts/lib/artifact-client.js) must escape ALL FIVE HTML metacharacters
 * (& < > " ') and must never let a quote-bearing URL break out of the
 * href="..." attribute that linkify() builds.
 *
 * artifact-client.js is a browser-only script (top-level `document.getElementById`
 * calls), so it cannot be imported/bundled directly in Node. Per the
 * self-contained-extension rule this file is NOT touched/imported at runtime by any
 * extension — this suite only READS it as text, extracts the PURE string
 * transforms plus `mdToHtml`, and evaluates them in an isolated `new Function`
 * sandbox. No esbuild/DOM needed: the tiny marked/sanitizer fakes below pin the
 * escaping contract without executing browser APIs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CLIENT_PATH = path.join(REPO_ROOT, ".claude", "scripts", "lib", "artifact-client.js");

const { check, counts } = createChecker();

/**
 * Extract the `esc` and `linkify` definitions from the real source file and evaluate
 * them in a fresh sandbox (no `document`, no other globals). Both are single-line
 * statements in the shipped file; `linkify` closes over `esc` via the shared
 * function-body scope, exactly as it does in the browser.
 */
function loadPureFunctions(source) {
	const escLine = /^const esc=.*;$/m.exec(source);
	if (!escLine) throw new Error("could not find `const esc=...;` line in artifact-client.js");
	const markdownStart = source.indexOf("const escapeMarkdownHtmlInlineCode=");
	const markdownFallbackStart = source.indexOf("const escapeMarkdownHtml=");
	const markdownBlockStart = markdownStart >= 0 ? markdownStart : markdownFallbackStart;
	const markdownBlockEnd = source.indexOf("const safeRenderedUrl=", markdownBlockStart);
	if (markdownBlockStart < 0 || markdownBlockEnd < 0) {
		throw new Error("could not find markdown escaper definitions in artifact-client.js");
	}
	const markdownBlock = source.slice(markdownBlockStart, markdownBlockEnd).trim();
	const linkifyLine = /var linkify=function\(t\)\{[^\n]*?\};/.exec(source);
	if (!linkifyLine) throw new Error("could not find `var linkify=function(t){...};` in artifact-client.js");
	const mdToHtmlLine = /var mdToHtml=function\(md\)\{[^\n]*?\};/.exec(source);
	if (!mdToHtmlLine) throw new Error("could not find `var mdToHtml=function(md){...};` in artifact-client.js");
	const factory = new Function(`${escLine[0]}
${markdownBlock}
const sanitizeRenderedHtml=(html)=>String(html);
const fakeEscape=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const tick=String.fromCharCode(96),fence=tick+tick+tick;
const fenceRe=new RegExp(fence+"(?:\\\\w+)?\\\\n([\\\\s\\\\S]*?)\\\\n"+fence,"g");
const inlineRe=new RegExp(tick+"([^"+tick+"]+)"+tick,"g");
const window={marked:{parse(md){return String(md).replace(fenceRe,function(_match,code){return "<pre><code>"+fakeEscape(code)+"</code></pre>";}).replace(inlineRe,function(_match,code){return "<code>"+fakeEscape(code)+"</code>";});}}};
const marked=window.marked;
${linkifyLine[0]}
${mdToHtmlLine[0]}
return { esc, escapeMarkdownHtml, linkify, mdToHtml };`);
	return factory();
}

function main() {
	const source = fs.readFileSync(CLIENT_PATH, "utf8");
	const { esc, escapeMarkdownHtml, linkify, mdToHtml } = loadPureFunctions(source);

	// 1) The escaper must cover all five metacharacters, in one pass — the 3-char
	// variant (only & < >) is the root cause of the attribute breakout below.
	check("esc escapes & < > \" '", esc(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;", JSON.stringify(esc(`&<>"'`)));

	// 2) Hostile fixture: a quote-bearing http(s) URL with no internal whitespace (so
	// linkify's own `[^\s)]+` URL-matching regex still finds it), which is a live
	// attribute-breakout regardless of it. linkify() wraps it in `(<a href="$1" ...)`.
	const HOSTILE_URL = 'http://evil.com"onmouseover=alert(1)';
	const out = linkify(`(${HOSTILE_URL})`);
	const hrefMatch = /href="(.*)" target="_blank"/.exec(out);
	check("linkify still emits an href for the hostile URL", !!hrefMatch, out);
	const hrefValue = hrefMatch ? hrefMatch[1] : "";

	// The core pin: the emitted href attribute value must contain NO raw quote — a raw
	// `"` there closes the attribute early and lets the rest of the URL be parsed as
	// new (attacker-controlled) attributes on the <a> tag (e.g. `onmouseover=...`).
	check('emitted href contains no raw "', !hrefValue.includes('"'), JSON.stringify(hrefValue));
	check("no live onmouseover= attribute breaks out of href", !/"\s*onmouseover=/.test(out), out);
	check("no javascript: href is ever emitted", !/href\s*=\s*"javascript:/i.test(out));

	// 3) Issue #60: artifact markdown must escape raw HTML outside code, but must not
	// pre-escape code spans/blocks before marked's own code renderer escapes them.
	const fencedCode = "```\nPromise<string>\n```";
	const inlineCode = "`Promise<string>`";
	check(
		"markdown escaper leaves fenced code raw for marked",
		escapeMarkdownHtml(fencedCode) === fencedCode,
		JSON.stringify(escapeMarkdownHtml(fencedCode)),
	);
	check(
		"markdown escaper leaves inline code raw for marked",
		escapeMarkdownHtml(inlineCode) === inlineCode,
		JSON.stringify(escapeMarkdownHtml(inlineCode)),
	);
	check(
		"markdown escaper still escapes raw HTML outside code",
		escapeMarkdownHtml("<script>x</script>") === "&lt;script&gt;x&lt;/script&gt;",
		escapeMarkdownHtml("<script>x</script>"),
	);
	const renderedCode = mdToHtml(fencedCode);
	check("artifact markdown code keeps one HTML escape", renderedCode.includes("Promise&lt;string&gt;"), renderedCode);
	check(
		"artifact markdown code is not double-escaped",
		!renderedCode.includes("Promise&amp;lt;string&amp;gt;"),
		renderedCode,
	);

	// 4) Regression guard: a clean URL still linkifies unchanged.
	const cleanOut = linkify("(http://good.example/path)");
	check("clean URL still linkified as-is", cleanOut.includes('href="http://good.example/path"'), cleanOut);

	if (counts.failed > 0) {
		console.error(`\n${counts.failed} checks FAILED:`);
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main();
