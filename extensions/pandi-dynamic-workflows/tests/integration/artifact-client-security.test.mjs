/**
 * artifact-client-security — pinea issue #33: el cliente de preview pre-launch
 * (.claude/scripts/lib/artifact-client.js) debe escapar LOS CINCO metacaracteres HTML
 * (& < > " ') y nunca debe dejar que una URL con comillas escape del atributo
 * href="..." que construye linkify().
 *
 * artifact-client.js es un script solo-browser (llamadas top-level a `document.getElementById`),
 * así que no puede importarse/bundlearse directamente en Node. Según la regla
 * self-contained-extension este archivo NO se toca/importa en runtime por ninguna
 * extensión — esta suite solo lo LEE como texto, extrae los transforms de string PUROS
 * más `mdToHtml`, y los evalúa en un sandbox `new Function` aislado.
 * No hace falta esbuild/DOM: los fakes mínimos de marked/sanitizer de abajo pinean el
 * contrato de escaping sin ejecutar APIs browser.
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
 * Extrae las definiciones de `esc` y `linkify` desde el archivo source real y las evalúa
 * en un sandbox fresco (sin `document`, sin otros globals). El extractor camina statements
 * completos, así no depende de que las funciones shipeadas sigan ocupando una sola línea.
 * `linkify` cierra sobre `esc` vía el scope compartido del function-body, exactamente como
 * lo hace en el browser.
 */
function previousNonSpace(source, index) {
	for (let i = index - 1; i >= 0; i--) if (/\S/.test(source[i])) return source[i];
	return "";
}

function startsRegexLiteral(source, index) {
	return "(=,:?[!{".includes(previousNonSpace(source, index));
}

function sliceStatement(source, startNeedle, label) {
	const start = source.indexOf(startNeedle);
	if (start < 0) throw new Error(`could not find ${label} in artifact-client.js`);
	let quote = null;
	let regex = false;
	let regexClass = false;
	let escaped = false;
	let paren = 0;
	let brace = 0;
	let bracket = 0;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (quote || regex) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (regex && ch === "[") regexClass = true;
			else if (regex && ch === "]") regexClass = false;
			else if (regex && ch === "/" && !regexClass) regex = false;
			else if (!regex && ch === quote) quote = null;
			continue;
		}
		if (ch === "/" && startsRegexLiteral(source, i)) {
			regex = true;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(") paren += 1;
		else if (ch === ")") paren -= 1;
		else if (ch === "{") brace += 1;
		else if (ch === "}") brace -= 1;
		else if (ch === "[") bracket += 1;
		else if (ch === "]") bracket -= 1;
		else if (ch === ";" && paren === 0 && brace === 0 && bracket === 0) return source.slice(start, i + 1);
	}
	throw new Error(`could not finish ${label} statement in artifact-client.js`);
}

function loadPureFunctions(source) {
	const escStatement = sliceStatement(source, "const esc=", "`const esc=...` statement");
	const markdownStart = source.indexOf("const escapeMarkdownHtmlInlineCode=");
	const markdownFallbackStart = source.indexOf("const escapeMarkdownHtml=");
	const markdownBlockStart = markdownStart >= 0 ? markdownStart : markdownFallbackStart;
	const markdownBlockEnd = source.indexOf("const safeRenderedUrl=", markdownBlockStart);
	if (markdownBlockStart < 0 || markdownBlockEnd < 0) {
		throw new Error("could not find markdown escaper definitions in artifact-client.js");
	}
	const markdownBlock = source.slice(markdownBlockStart, markdownBlockEnd).trim();
	const linkifyStatement = sliceStatement(source, "var linkify=function", "`var linkify=function...` statement");
	const mdToHtmlStatement = sliceStatement(source, "var mdToHtml=function", "`var mdToHtml=function...` statement");
	const factory = new Function(`${escStatement}
${markdownBlock}
const sanitizeRenderedHtml=(html)=>String(html);
const fakeEscape=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const tick=String.fromCharCode(96),fence=tick+tick+tick;
const fenceRe=new RegExp(fence+"(?:\\\\w+)?\\\\n([\\\\s\\\\S]*?)\\\\n"+fence,"g");
const inlineRe=new RegExp(tick+"([^"+tick+"]+)"+tick,"g");
const window={marked:{parse(md){return String(md).replace(fenceRe,function(_match,code){return "<pre><code>"+fakeEscape(code)+"</code></pre>";}).replace(inlineRe,function(_match,code){return "<code>"+fakeEscape(code)+"</code>";});}}};
const marked=window.marked;
${linkifyStatement}
${mdToHtmlStatement}
return { esc, escapeMarkdownHtml, linkify, mdToHtml };`);
	return factory();
}

function main() {
	const source = fs.readFileSync(CLIENT_PATH, "utf8");
	const { esc, escapeMarkdownHtml, linkify, mdToHtml } = loadPureFunctions(source);

	// 1) El escaper debe cubrir los cinco metacaracteres, en una pasada — la variante de 3 chars
	// (solo & < >) es la causa raíz del breakout de atributo de abajo.
	check("esc escapes & < > \" '", esc(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;", JSON.stringify(esc(`&<>"'`)));

	// 2) Fixture hostil: una URL http(s) con comillas y sin whitespace interno (así
	// la regex propia de linkify `[^\s)]+` para matchear URL todavía la encuentra), que es un
	// attribute-breakout vivo de todos modos. linkify() la envuelve en `(<a href="$1" ...)`.
	const HOSTILE_URL = 'http://evil.com"onmouseover=alert(1)';
	const out = linkify(`(${HOSTILE_URL})`);
	const hrefMatch = /href="(.*)" target="_blank"/.exec(out);
	check("linkify still emits an href for the hostile URL", !!hrefMatch, out);
	const hrefValue = hrefMatch ? hrefMatch[1] : "";

	// El pin central: el valor del atributo href emitido NO debe contener comillas raw — una
	// `"` raw ahí cierra el atributo antes de tiempo y deja que el resto de la URL se parseé como
	// atributos nuevos (controlados por atacante) en el tag <a> (p. ej. `onmouseover=...`).
	check('emitted href contains no raw "', !hrefValue.includes('"'), JSON.stringify(hrefValue));
	check("no live onmouseover= attribute breaks out of href", !/"\s*onmouseover=/.test(out), out);
	check("no javascript: href is ever emitted", !/href\s*=\s*"javascript:/i.test(out));

	// 3) Issue #60: artifact markdown debe escapar HTML raw fuera de código, pero no debe
	// pre-escapar spans/blocks de código antes de que el renderer de código propio de marked los escape.
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

	// 4) Guardia de regresión: una URL limpia todavía se linkifica sin cambios.
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
