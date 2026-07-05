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
// Sin -o cada entrada escribe un archivo hermano <input>.html; -o solo es válido con una entrada.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Marked } from "marked";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_CSS_PATH = path.join(EXT_DIR, "skills", "pandi-artifact-style", "reference", "pandi-tokens.css");

const ALERT_CALLOUTS = {
	NOTE: "info",
	TIP: "success",
	IMPORTANT: "info",
	WARNING: "warn",
	CAUTION: "error",
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
main h2 { font-size:24px; color:var(--ink); margin:32px 0 10px; font-weight:600; }
main h3 { font-size:19px; color:var(--ink); margin:22px 0 8px; font-weight:600; }
main h4 { font-size:17px; color:var(--ink); margin:18px 0 6px; font-weight:600; }
main h5, main h6 { font-size:16px; color:var(--ink2); margin:16px 0 6px; font-weight:600; }
main p, main li { color:var(--ink2); text-align:justify; hyphens:auto; }
main li { margin:3px 0; }
a { color:var(--link); }
strong { color:var(--ink); }
code { font-family:ui-monospace,Menlo,monospace; font-size:16px; color:var(--code);
       background:var(--raised); padding:1px 6px; border-radius:5px; }
pre { background:var(--paper); border:1px solid var(--line); border-radius:12px;
      padding:16px; overflow:auto; font-size:16px; line-height:1.6; }
pre code { background:none; padding:0; color:var(--ink); }
pre.mermaid { text-align:center; }
blockquote { border-left:3px solid var(--accent); margin:8px 0; padding:2px 14px; color:var(--ink2); }
blockquote p { margin:6px 0; }
hr { border:none; border-top:1px solid var(--line-strong); margin:24px 0; }
table { border-collapse:collapse; margin:12px 0; background:var(--paper);
        border:1px solid var(--line); border-radius:12px; overflow:hidden; }
th, td { border-bottom:1px solid var(--line); padding:8px 12px; text-align:left; font-size:16px; }
th { font-size:14px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);
     background:var(--raised); }
tr:last-child td { border-bottom:none; }
.callout { margin:12px 0; padding:10px 14px; border-radius:10px; font-size:16px;
           border:1px solid var(--line); background:var(--paper); color:var(--ink); }
.callout p { margin:6px 0; color:var(--ink); max-width:none; }
.callout.info    { background:var(--info-bg);    border-color:var(--purple); }
.callout.success { background:var(--success-bg); border-color:var(--success); }
.callout.warn    { background:var(--warning-bg); border-color:var(--warning); }
.callout.error   { background:var(--error-bg);   border-color:var(--error); }
footer { margin-top:40px; color:var(--muted); font-size:15px; }
`;

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Motor Markdown: GFM + un renderizador de código que convierte bloques ```mermaid en contenedores
// de diagramas (mermaid lee textContent, así que el escape de entidades sigue siendo correcto y seguro).
const engine = new Marked({
	gfm: true,
	renderer: {
		code(token) {
			if ((token.lang || "").trim() === "mermaid") return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
			return false; // usa el renderizador de código por defecto
		},
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

// Mapea blockquotes de alertas de GitHub (> [!NOTE] …) a callouts pandi posprocesando el
// HTML renderizado: más simple y más estable que sobreescribir los renderizadores de tokens de marked.
function alertsToCallouts(html) {
	const kinds = Object.keys(ALERT_CALLOUTS).join("|");
	const marker = new RegExp(`<blockquote>\\s*<p>\\[!(${kinds})\\]\\s*(?:<br\\s*/?>\\s*)?`, "g");
	let out = html.replace(marker, (_all, kind) => `<div class="callout ${ALERT_CALLOUTS[kind]}"><p>`);
	// Cierra el div solo para los blockquotes que abrimos como callouts.
	if (out !== html)
		out = out.replace(/<\/blockquote>/g, (close, idx) => {
			const opened = out.lastIndexOf('<div class="callout', idx);
			const openedQuote = out.lastIndexOf("<blockquote>", idx);
			return opened > openedQuote ? "</div>" : close;
		});
	return out;
}

export function renderMarkdownToHtml(md, opts = {}) {
	const tokensCss = opts.tokensCss ?? fs.readFileSync(TOKENS_CSS_PATH, "utf8");
	const kicker = opts.kicker ?? "Pandi artifact";
	const { title: docTitle, body } = splitTitle(stripYamlFrontmatter(md));
	const title = docTitle ?? opts.title ?? "Untitled";
	const rendered = alertsToCallouts(engine.parse(body, { async: false }));
	const mermaidBlock = rendered.includes('<pre class="mermaid">') ? `${mermaidScript(tokensCss)}\n` : "";

	return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${tokensCss}
${BODY_CSS}</style>
</head>
<body>
<div class="container">
	<header>
		<div class="kicker">${escapeHtml(kicker)}</div>
		<h1>${escapeHtml(title)}</h1>
	</header>
	<main>
${rendered}	</main>
	<footer>Generated with the pandi-artifact-style skill · palette: panda-syntax dark/light</footer>
</div>
${mermaidBlock}</body>
</html>
`;
}

export function parseArgs(argv) {
	const inputs = [];
	let out = null;
	let kicker;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-o" || a === "--out") out = argv[++i];
		else if (a === "--kicker") kicker = argv[++i];
		else if (a === "-h" || a === "--help") return { help: true };
		else if (a.startsWith("-")) throw new Error(`flag desconocida: ${a}`);
		else inputs.push(a);
	}
	return { inputs, out, kicker };
}

function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help || !parsed.inputs?.length) {
		console.log('Uso: markdown-to-html.mjs <input.md> [más.md…] [-o output.html] [--kicker "Texto"]');
		process.exit(parsed.help ? 0 : 1);
	}
	if (parsed.out && parsed.inputs.length > 1) {
		console.error("-o solo es válido con un único archivo de entrada");
		process.exit(1);
	}
	for (const input of parsed.inputs) {
		const md = fs.readFileSync(input, "utf8");
		const outPath = parsed.out ?? `${input.replace(/\.md$/i, "")}.html`;
		const html = renderMarkdownToHtml(md, { title: path.basename(input), kicker: parsed.kicker });
		fs.writeFileSync(outPath, html);
		console.log(`${input} -> ${outPath}`);
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
