#!/usr/bin/env node
// generate-claude-workflows.mjs — genera de forma determinista el dialecto de
// script top-level de Claude Code para cada scaffold pi canónico
// (extensions/pandi-dynamic-workflows/scaffolds/*.js) en DOS destinos:
//   1. .claude/workflows/*.js — el catálogo Claude del repo (sincronizado a ~/.claude).
//   2. .pi/skills/ultracode/reference/claude-workflows/*.js — la copia de referencia
//      autocontenida del skill ultracode (#26); viaja con el skill mediante los
//      syncs de skills (gen-claude-ultracode, vendor-extension-skills).
//
// Los scaffolds de pi son la FUENTE DE VERDAD. Los archivos de Claude son artifacts generados:
// no los edites a mano — editá el scaffold de pi y re-ejecutá esto. Un test de parity
// (tests/.../claude-parity) protege contra drift en AMBOS destinos.
//
// Transformación (la única delta real pi->claude; ver git history / plan):
//   1. Entry-point: desenvuelve `export default async function main() { <body> }` a un
//      body top-level que termina en `return` (Claude exige scripts top-level; rechaza
//      export-default-main — verificado empíricamente).
//   2. Catalog-prose: reescribe las referencias y la redacción del catálogo .pi/workflows + ~/.pi/agent/workflows
//      a sus equivalentes de Claude (solo router/contract-gate/
//      workflow-factory contienen esto).
//   3. Re-format con prettier (parser: babel — biome no puede parsear top-level return).
// Todo lo demás (template literals, ?., ??, meta incl. basedOn, lógica) se conserva.
//
// Uso:
//   node .claude/scripts/generate-claude-workflows.mjs           # escribe todo
//   node .claude/scripts/generate-claude-workflows.mjs --check   # verifica y sale con 1 si hay drift

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const SRC_DIR = join(REPO, "extensions", "pandi-dynamic-workflows", "scaffolds");
const OUT_DIRS = [
	join(REPO, ".claude", "workflows"),
	join(REPO, ".pi", "skills", "ultracode", "reference", "claude-workflows"),
];

const PRETTIER_OPTS = {
	parser: "babel",
	useTabs: true,
	tabWidth: 3,
	printWidth: 120,
	semi: true,
	singleQuote: false,
	trailingComma: "all",
	arrowParens: "always",
};

// Reescrituras de catalog-prose (pi -> claude). Cada `find` es un substring verbatim distintivo
// que aparece exactamente en un scaffold; aplicarlo globalmente es seguro.
const CATALOG_REWRITES = [
	// router.js — comentario de bloque del header (abarca dos líneas de comentario)
	[
		"reading the catalog (the project .pi/workflows/*.js and the global\n * ~/.pi/agent/workflows/*.js), excluding",
		"reading the catalog (~/.claude/workflows/*.js and, if present, ./.claude/\n * workflows/*.js), excluding",
	],
	// router.js — prompt de descubrimiento de catálogo
	[
		"EXISTING pi dynamic workflows disponibles para dispatch. Leé el catálogo del proyecto en .pi/workflows/*.js y, si existe, el catálogo global en ~/.pi/agent/workflows/*.js.",
		"EXISTING Claude Code dynamic workflows disponibles para dispatch. Leé el catálogo de usuario en ~/.claude/workflows/*.js y, si existe, el catálogo del proyecto en ./.claude/workflows/*.js.",
	],
	// workflow-factory.js — prompt de descubrimiento de catálogo
	[
		"EXISTING pi dynamic workflows disponibles para reuse/compose. Leé el catálogo del proyecto en .pi/workflows/*.js y, si existe, el catálogo global en ~/.pi/agent/workflows/*.js.",
		"EXISTING Claude Code dynamic workflows disponibles para reuse/compose. Leé el catálogo de usuario en ~/.claude/workflows/*.js y, si existe, el catálogo del proyecto en .claude/workflows/*.js.",
	],
	// workflow-factory.js — draft path (comentario + código), substring compartido
	[".pi/workflows/drafts/", ".claude/workflows/drafts/"],
	// contract-gate.js — prompt de patrón de lectura (preserva la lectura de DOS paths de pi: global + project-local)
	[
		"Primero leé .pi/workflows/${routing.pattern}.js (o el global ~/.pi/agent/workflows/${routing.pattern}.js) y extraé",
		"Primero leé ~/.claude/workflows/${routing.pattern}.js (o el del proyecto ./.claude/workflows/${routing.pattern}.js) y extraé",
	],
];

const WRAP_RE = /^export default async function main\(\)\s*\{\s*$/;

function unwrapMain(src, name) {
	const lines = src.split("\n");
	const wrapIdx = lines.findIndex((l) => WRAP_RE.test(l));
	if (wrapIdx === -1) throw new Error(`${name}: no \`export default async function main() {\` wrapper found`);
	let closeIdx = -1;
	for (let i = lines.length - 1; i > wrapIdx; i--) {
		if (lines[i] === "}") {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) throw new Error(`${name}: no top-level closing \`}\` found after wrapper`);
	// main() debe ser la ÚLTIMA construcción top-level — fallá ruidosamente si un scaffold futuro agrega
	// código después (si no, el ancla inversa "last bare }" lo descartaría en silencio).
	for (let i = closeIdx + 1; i < lines.length; i++) {
		if (lines[i].trim() !== "") throw new Error(`${name}: unexpected top-level code after main() close (line ${i + 1})`);
	}
	const head = lines.slice(0, wrapIdx); // comentarios de licencia/header + export const meta
	const body = lines.slice(wrapIdx + 1, closeIdx); // body de la función (sobreindentado; prettier lo corrige)
	return [...head, ...body].join("\n");
}

function applyCatalogRewrites(src) {
	let out = src;
	for (const [find, replace] of CATALOG_REWRITES) out = out.split(find).join(replace);
	return out;
}

async function generateOne(name, src) {
	const rewritten = applyCatalogRewrites(src);
	const unwrapped = unwrapMain(rewritten, name);
	const formatted = await prettier.format(unwrapped, PRETTIER_OPTS);
	// Red de seguridad: ningún token de catálogo de pi-runtime puede sobrevivir dentro de un artifact de Claude.
	// También las formas peladas (sin `~/`): atrapá cualquier referencia remanente al catálogo de pi-runtime.
	for (const token of [".pi/workflows", ".pi/agent/workflows", "EXISTING pi dynamic"]) {
		if (formatted.includes(token)) throw new Error(`${name}: pi catalog token survived rewrite: "${token}"`);
	}
	return formatted;
}

async function main() {
	const check = process.argv.includes("--check");
	const files = (await readdir(SRC_DIR)).filter((f) => f.endsWith(".js")).sort();
	let drift = 0;
	let wrote = 0;
	for (const f of files) {
		const src = await readFile(join(SRC_DIR, f), "utf8");
		const generated = await generateOne(f, src);
		for (const outDir of OUT_DIRS) {
			const outPath = join(outDir, f);
			const rel = relative(REPO, outPath);
			let current = null;
			try {
				current = await readFile(outPath, "utf8");
			} catch {}
			if (check) {
				if (current !== generated) {
					console.error(`  drift: ${rel}`);
					drift++;
				}
			} else if (current !== generated) {
				await writeFile(outPath, generated);
				console.log(`  wrote: ${rel}`);
				wrote++;
			}
		}
	}
	const total = files.length * OUT_DIRS.length;
	if (check) {
		if (drift > 0) {
			console.error(`[generate-claude-workflows] ❌ ${drift}/${total} out of date — run without --check.`);
			process.exit(1);
		}
		console.log(`[generate-claude-workflows] ✅ all ${total} in sync (${OUT_DIRS.length} destinations).`);
	} else {
		console.log(`[generate-claude-workflows] done — ${wrote} written, ${total - wrote} unchanged.`);
	}
}

main().catch((e) => {
	console.error("[generate-claude-workflows] ERROR:", e.message);
	process.exit(2);
});
