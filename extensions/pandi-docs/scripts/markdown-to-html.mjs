#!/usr/bin/env node
// markdown-to-html.mjs — convierte Markdown en un artifact HTML autocontenido con estilo según el
// manual pandi-artifact-style (layout Claude-design × paleta Panda Syntax).
//
// Los tokens se leen en tiempo de ejecución desde la copia vendoreada del skill de la extensión
// (../skills/pandi-artifact-style/reference/pandi-tokens.css, mantenida idéntica byte a byte con la
// fuente canónica de .pi/skills por vendor-extension-skills.mjs; los colores derivan de
// extensions/pandi-theme/themes/panda-syntax-{dark,light}.json).
//
// Uso:
//   node markdown-to-html.mjs <input.md> [más.md…] [-o output.html] [--kicker "Text"]
//
// Sin -o, cada entrada escribe un archivo hermano <input>.html; -o solo es válido con una entrada.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_CSS_PATH = path.join(EXT_DIR, "skills", "pandi-artifact-style", "reference", "pandi-tokens.css");

const ALERT_CALLOUTS = {
	NOTE: { tone: "info", label: "Nota" },
	TIP: { tone: "success", label: "Consejo" },
	IMPORTANT: { tone: "info", label: "Importante" },
	WARNING: { tone: "warn", label: "Advertencia" },
	CAUTION: { tone: "error", label: "Precaución" },
};

// Estilos del componente para el cuerpo Markdown renderizado — las recetas de SKILL.md
// (superficies paper/ink, jerarquía sobria, títulos de sección en mayúsculas, monospace para código).
const BODY_CSS = `
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
       font:18px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif; }
.container { max-width:980px; margin:0 auto; padding:0 24px 80px; }
header { padding:40px 0 8px; }
header .kicker { font-size:14px; letter-spacing:.12em; text-transform:uppercase;
                 color:var(--accent); font-weight:600; }
header h1 { margin:6px 0; font-size:34px; }
header .lede { margin:10px 0 0; font-size:20px; line-height:1.55; color:var(--ink2); max-width:64ch; }
main h2 { font-size:24px; color:var(--ink); margin:32px 0 10px; font-weight:600; }
main h3 { font-size:19px; color:var(--ink); margin:22px 0 8px; font-weight:600; }
main h4 { font-size:17px; color:var(--ink); margin:18px 0 6px; font-weight:600; }
main h5, main h6 { font-size:16px; color:var(--ink2); margin:16px 0 6px; font-weight:600; }
main p, main li { color:var(--ink2); text-align:justify; hyphens:auto; }
main li { margin:3px 0; }
.mermaid p, .mermaid span, .mermaid div, .mermaid foreignObject * {
  text-align:center !important; hyphens:none !important;
}
a { color:var(--link); }
strong { color:var(--ink); }
code { font-family:ui-monospace,Menlo,monospace; font-size:16px; color:var(--code);
       background:var(--raised); padding:1px 6px; border-radius:5px; }
pre { margin:16px 0; background:var(--paper); border:1px solid var(--line); border-radius:12px;
      padding:16px; overflow:auto; font-size:16px; line-height:1.6; }
pre code { display:block; min-width:max-content; background:none; padding:0; color:var(--ink);
           white-space:pre; tab-size:2; }
.hljs { background:transparent; color:var(--ink); }
.hljs-keyword, .hljs-selector-tag, .hljs-subst { color:var(--accent); }
.hljs-title, .hljs-section, .hljs-name, .hljs-function .hljs-title { color:var(--info); }
.hljs-string, .hljs-doctag, .hljs-regexp { color:var(--success); }
.hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet { color:var(--warning); }
.hljs-type, .hljs-class .hljs-title, .hljs-built_in { color:var(--purple); }
.hljs-comment, .hljs-quote { color:var(--line-strong); font-style:italic; }
.hljs-attr, .hljs-attribute, .hljs-meta { color:var(--ink2); }
.hljs-deletion { color:var(--error); }
.hljs-addition { color:var(--success); }
pre.mermaid { text-align:center; }
blockquote { border-left:3px solid var(--accent); margin:8px 0; padding:2px 14px; color:var(--ink2); }
blockquote p { margin:6px 0; }
hr { border:none; border-top:1px solid var(--line-strong); margin:24px 0; }
.table-scroll { overflow-x:auto; margin:12px 0; background:var(--paper);
                border:1px solid var(--line); border-radius:12px; }
table { border-collapse:collapse; width:100%; }
th, td { border-bottom:1px solid var(--line); padding:8px 12px; text-align:left; font-size:16px; }
th { font-size:14px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);
     background:var(--raised); }
tr:last-child td { border-bottom:none; }
.callout { margin:12px 0; padding:10px 14px; border-radius:10px; font-size:16px;
           border:1px solid var(--line); background:var(--paper); color:var(--ink); }
.callout p, .callout li { margin:6px 0; color:var(--ink); max-width:none;
                          text-align:left; hyphens:none; }
.callout .callout-label { font-size:12px; letter-spacing:.1em; text-transform:uppercase;
                          color:var(--muted); font-weight:600; margin:0 0 4px; }
.callout.info    { background:var(--info-bg);    border-color:var(--purple); }
.callout.success { background:var(--success-bg); border-color:var(--success); }
.callout.warn    { background:var(--warning-bg); border-color:var(--warning); }
.callout.error   { background:var(--error-bg);   border-color:var(--error); }
nav.toc { font-size:14px; border:1px solid var(--line); border-radius:12px;
          background:var(--paper); padding:14px 18px; margin:8px 0 28px; }
nav.toc .toc-title { font-size:12px; letter-spacing:.1em; text-transform:uppercase;
                     color:var(--muted); font-weight:600; margin:0 0 8px; }
nav.toc ol { list-style:none; margin:0; padding:0; display:grid;
             grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:2px 24px; }
nav.toc a { color:var(--ink2); text-decoration:none; display:block; padding:2px 0; }
nav.toc a:hover { color:var(--accent); }
.hex-chip { display:inline-flex; align-items:center; white-space:nowrap; }
.hex-chip .dot { display:inline-block; width:0.85em; height:0.85em; border-radius:3px;
                 margin-right:0.4em; vertical-align:-0.08em; box-shadow:inset 0 0 0 1px var(--line-strong);
                 flex-shrink:0; }
footer { margin-top:40px; color:var(--muted); font-size:15px; }
`;

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const decodeNumericHtmlEntities = (value) =>
	String(value).replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (entity, hex, decimal) => {
		const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
		return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
	});

const hasJavascriptProtocol = (value) =>
	decodeNumericHtmlEntities(value)
		.replace(/[\u0000-\u0020\u007f]+/g, "")
		.toLowerCase()
		.startsWith("javascript:");

// Slugs compatibles con GitHub para que anchors escritos a mano (#seccion-existente) sigan
// funcionando: saca tags/entidades/puntuación, conserva letras unicode y _, y usa un guion por espacio.
const slugify = (html) =>
	html
		.replace(/<[^>]+>/g, "")
		.replace(/&#?\w+;/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.trim()
		.replace(/\s/g, "-");

// Sanitiza HTML crudo permitido por Markdown antes de insertarlo en el artifact. Mantiene la
// mayoría de tags semánticos, pero elimina superficies ejecutables típicas (scripts/iframes) y
// atributos inline que disparan JS. El script controlado de Mermaid se agrega DESPUÉS de esta fase.
const sanitizeRenderedHtml = (html) =>
	html
		.replace(/<\s*(script|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
		.replace(/<\s*(script|iframe|object|embed)\b[^>]*\/?>/gi, "")
		.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(
			/\s+(href|src)\s*=\s*(?:(["'])([\s\S]*?)\2|([^\s>]+))/gi,
			(attribute, _name, _quote, quotedValue, unquotedValue) =>
				hasJavascriptProtocol(quotedValue ?? unquotedValue) ? "" : attribute,
		);

// Envuelve cada tabla en un contenedor con scroll horizontal: una tabla más ancha que la
// página scrollea en vez de desbordar. Tolera tags con atributos para no dejar divs desbalanceados.
const wrapTables = (html) =>
	html
		.replace(/<table(\s[^>]*)?>/g, (_, attrs) => `<div class="table-scroll"><table${attrs ?? ""}>`)
		.replaceAll("</table>", "</table></div>");

// Marca cada `#RRGGBB` en un code span inline con un swatch de color — no toca hashes de prosa
// (issue #123) porque el code span ya viene delimitado por marked antes de este paso.
const addColorDots = (html) =>
	html.replace(
		/<code>(#[0-9A-Fa-f]{6})<\/code>/g,
		'<span class="hex-chip"><span class="dot" style="background:$1"></span><code>$1</code></span>',
	);

// Agrega ids con slug a cada <h2> (colisiones resueltas con sufijo -N al estilo GitHub) y
// devuelve la tabla de contenidos: el patrón interno "temperado" evita que un <h2> mal cerrado
// se trague el próximo heading real.
function addHeadingIdsAndToc(html) {
	const headings = [];
	const usedSlugs = new Set();
	const withIds = html.replace(/<h2>((?:(?!<h2[\s>])[\s\S])*?)<\/h2>/g, (_, inner) => {
		let slug = slugify(inner) || "section";
		if (usedSlugs.has(slug)) {
			let i = 1;
			while (usedSlugs.has(`${slug}-${i}`)) i++;
			slug = `${slug}-${i}`;
		}
		usedSlugs.add(slug);
		headings.push({ slug, inner });
		return `<h2 id="${slug}">${inner}</h2>`;
	});
	const toc =
		headings.length >= 4
			? `<nav class="toc">
	<p class="toc-title">Contenido</p>
	<ol>
${headings.map((h) => `		<li><a href="#${h.slug}">${h.inner.replace(/<\/?a\b[^>]*>/g, "")}</a></li>`).join("\n")}
	</ol>
</nav>\n`
			: "";
	return { body: withIds, toc };
}
const codeLanguage = (lang) => (lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
const classToken = (lang) => lang.replace(/[^A-Za-z0-9_-]/g, "-");

function highlightCode(text, lang) {
	const source = String(text ?? "");
	if (lang && hljs.getLanguage(lang)) return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
	return escapeHtml(source);
}

function renderCodeBlock(token) {
	const lang = codeLanguage(token.lang);
	if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
	const languageClass = lang ? ` language-${classToken(lang)}` : "";
	return `<pre><code class="hljs${languageClass}">${highlightCode(token.text, lang)}</code></pre>\n`;
}

// Motor Markdown: GFM + un renderizador de código que convierte bloques ```mermaid en contenedores
// de diagramas y resalta el resto de fences en build-time. Así los artifacts siguen siendo
// autocontenidos: el HTML ya lleva los spans coloreables y no necesita JS en runtime para código.
const engine = new Marked({
	gfm: true,
	renderer: {
		code: renderCodeBlock,
	},
});

// Extrae las custom properties CSS de pandi-tokens.css (dark = primer bloque :root,
// light = bloque prefers-color-scheme), para que el theming de mermaid comparta la única fuente
// de verdad en vez de duplicar valores hex.
function parseTokenVariants(tokensCss) {
	let split = tokensCss.search(/@media[^{]*prefers-color-scheme:\s*light/);
	if (split < 0) split = tokensCss.length; // sin bloque light: reutiliza dark para ambos
	const grab = (css) => {
		const vars = {};
		for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) vars[m[1]] = m[2];
		return vars;
	};
	return { dark: grab(tokensCss.slice(0, split)), light: grab(tokensCss.slice(split)) };
}

// Mapea los tokens pandi a las themeVariables `base` de mermaid (mismos roles semánticos que el manual).
function mermaidThemeVariables(vars) {
	return {
		background: vars.bg,
		mainBkg: vars.paper,
		primaryColor: vars.raised,
		primaryTextColor: vars.ink,
		primaryBorderColor: vars["line-strong"],
		lineColor: vars.muted,
		secondaryColor: vars["info-bg"],
		tertiaryColor: vars.raised,
		textColor: vars.ink2,
		titleColor: vars.accent,
		nodeTextColor: vars.ink,
		edgeLabelBackground: vars.bg,
		clusterBkg: vars["info-bg"],
		clusterBorder: vars.line,
		fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif',
	};
}

function mermaidScript(tokensCss) {
	const { dark, light } = parseTokenVariants(tokensCss);
	const themes = JSON.stringify({ dark: mermaidThemeVariables(dark), light: mermaidThemeVariables(light) });
	return `<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
const pandiMermaidThemes = ${themes};
mermaid.initialize({
	startOnLoad: true,
	theme: "base",
	themeVariables: pandiMermaidThemes[matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"],
});
</script>`;
}

// Quita frontmatter YAML opcional antes de extraer/renderizar el título. Los docs pueden usar
// frontmatter para metadata de skills u OKF; el artifact HTML debe mostrar prosa, no metadata.
function stripYamlFrontmatter(md) {
	if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return md;
	const newline = md.startsWith("---\r\n") ? "\r\n" : "\n";
	const close = md.indexOf(`${newline}---${newline}`, 4);
	if (close < 0) return md;
	return md.slice(close + newline.length + 3 + newline.length);
}

// Extrae el primer `# heading` de nivel superior como título de la página y lo quita del cuerpo.
function splitTitle(md) {
	const lines = md.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*$/.test(line)) continue;
		const m = /^#\s+(.+?)\s*$/.exec(line);
		if (m) return { title: m[1], body: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n") };
		break; // la primera línea no vacía no es un h1 — conserva intacto el documento
	}
	return { title: null, body: md };
}

// Promociona el primer párrafo del cuerpo como lede del header — la "apertura en 30 segundos"
// del doc, destacada bajo el h1. Solo texto: un párrafo que arranca con imagen queda en el cuerpo.
function extractLede(rendered) {
	const m = /^\s*<p>([\s\S]*?)<\/p>\n?/.exec(rendered);
	if (!m || m[1].includes("<img")) return { lede: "", body: rendered };
	return { lede: m[1], body: rendered.slice(m[0].length) };
}

// Mapea blockquotes de alertas de GitHub (> [!NOTE] …) a callouts Pandi posprocesando el
// HTML renderizado: más simple y más estable que sobreescribir los renderizadores de tokens de marked.
function alertsToCallouts(html) {
	const kinds = Object.keys(ALERT_CALLOUTS).join("|");
	const marker = new RegExp(`<blockquote>\\s*<p>\\[!(${kinds})\\]\\s*(?:<br\\s*/?>\\s*)?`, "g");
	let out = html.replace(marker, (_all, kind) => {
		const { tone, label } = ALERT_CALLOUTS[kind];
		return `<div class="callout ${tone}"><p class="callout-label">${label}</p><p>`;
	});
	if (out === html) return out;
	// Un marcador solo en su párrafo deja un <p> vacío detrás de la etiqueta.
	out = out.replace(/(<p class="callout-label">[^<]+<\/p>)<p>\s*<\/p>/g, "$1");
	// Cierra el div solo para los blockquotes que abrimos como callouts.
	return out.replace(/<\/blockquote>/g, (close, idx) => {
		const opened = out.lastIndexOf('<div class="callout', idx);
		const openedQuote = out.lastIndexOf("<blockquote>", idx);
		return opened > openedQuote ? "</div>" : close;
	});
}

export function renderMarkdownToHtml(md, opts = {}) {
	// `css` reemplaza la hoja de estilos COMPLETA (tokens + body css) — para repos con look
	// propio; `tokensCss` solo pisa la paleta manteniendo el layout pandi.
	const tokensCss = opts.css ? undefined : (opts.tokensCss ?? fs.readFileSync(TOKENS_CSS_PATH, "utf8"));
	const styleCss = opts.css ?? `${tokensCss}\n${BODY_CSS}`;
	const kicker = opts.kicker ?? "Pandi artifact";
	const { title: docTitle, body } = splitTitle(stripYamlFrontmatter(md));
	const title = docTitle ?? opts.title ?? "Untitled";
	const { body: withIds, toc } = addHeadingIdsAndToc(
		alertsToCallouts(sanitizeRenderedHtml(engine.parse(body, { async: false }))),
	);
	const processed = addColorDots(wrapTables(withIds));
	// El lede solo existe cuando hubo h1 que promover: sin masthead propio no hay dónde colgarlo.
	const { lede, body: rendered } = docTitle ? extractLede(processed) : { lede: "", body: processed };
	const mermaidBlock = rendered.includes('<pre class="mermaid">') ? `${mermaidScript(opts.css ?? tokensCss)}\n` : "";

	return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${styleCss}</style>
</head>
<body>
<div class="container">
	<header>
		<div class="kicker">${escapeHtml(kicker)}</div>
		<h1>${escapeHtml(title)}</h1>${lede ? `\n\t\t<p class="lede">${lede}</p>` : ""}
	</header>
	<main>
${toc}${rendered}	</main>
	<footer>Generado con el skill pandi-artifact-style · paleta: panda-syntax dark/light</footer>
</div>
${mermaidBlock}</body>
</html>
`;
}

export function parseArgs(argv) {
	const inputs = [];
	let out = null;
	let kicker;
	let tokens;
	let css;
	const takeValue = (flag, index) => {
		const value = argv[index + 1];
		if (!value || value.startsWith("-")) throw new Error(`${flag} requiere un valor`);
		return value;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-o" || a === "--out") out = takeValue(a, i++);
		else if (a === "--kicker") kicker = takeValue(a, i++);
		else if (a === "--tokens") tokens = takeValue(a, i++);
		else if (a === "--css") css = takeValue(a, i++);
		else if (a === "-h" || a === "--help") return { help: true };
		else if (a.startsWith("-")) throw new Error(`flag desconocida: ${a}`);
		else inputs.push(a);
	}
	return { inputs, out, kicker, tokens, css };
}

function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help || !parsed.inputs?.length) {
		console.log(
			'Uso: markdown-to-html.mjs <input.md> [más.md…] [-o output.html] [--kicker "Texto"] [--tokens tokens.css] [--css estilo.css]',
		);
		process.exit(parsed.help ? 0 : 1);
	}
	if (parsed.out && parsed.inputs.length > 1) {
		console.error("-o solo es válido con un único archivo de entrada");
		process.exit(1);
	}
	const tokensCss = parsed.tokens ? fs.readFileSync(parsed.tokens, "utf8") : undefined;
	const css = parsed.css ? fs.readFileSync(parsed.css, "utf8") : undefined;
	for (const input of parsed.inputs) {
		const md = fs.readFileSync(input, "utf8");
		const outPath = parsed.out ?? `${input.replace(/\.md$/i, "")}.html`;
		const html = renderMarkdownToHtml(md, { title: path.basename(input), kicker: parsed.kicker, tokensCss, css });
		fs.writeFileSync(outPath, html);
		console.log(`Se escribió ${outPath} desde ${input}`);
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
