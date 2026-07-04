/**
 * artifact-client-security — pins issue #33: the pre-launch preview client
 * (.claude/scripts/lib/artifact-client.js) must escape ALL FIVE HTML metacharacters
 * (& < > " ') and must never let a quote-bearing URL break out of the
 * href="..." attribute that linkify() builds.
 *
 * artifact-client.js is a browser-only script (top-level `document.getElementById`
 * calls), so it cannot be imported/bundled directly in Node. Per the
 * self-contained-extension rule this file is NOT touched/imported at runtime by any
 * extension — this suite only READS it as text, extracts the two PURE, DOM-free
 * function definitions (`esc` and `linkify`, which depend only on each other) via
 * regex, and evaluates them in an isolated `new Function` sandbox. No esbuild/DOM
 * needed: both functions are plain string transforms.
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
	const linkifyLine = /var linkify=function\(t\)\{[^\n]*?\};/.exec(source);
	if (!linkifyLine) throw new Error("could not find `var linkify=function(t){...};` in artifact-client.js");
	const factory = new Function(`${escLine[0]}\n${linkifyLine[0]}\nreturn { esc, linkify };`);
	return factory();
}

function main() {
	const source = fs.readFileSync(CLIENT_PATH, "utf8");
	const { esc, linkify } = loadPureFunctions(source);

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

	// 3) Regression guard: a clean URL still linkifies unchanged.
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
