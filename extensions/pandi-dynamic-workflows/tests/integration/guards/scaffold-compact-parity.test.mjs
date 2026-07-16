#!/usr/bin/env node
/**
 * Los scaffolds no pueden importar módulos compartidos (los scripts de workflow corren
 * standalone), así que el helper `compact` vive copiado en cada archivo. Este guard pinea que
 * las copias no derivan en silencio: 23 scaffolds llevan la forma estándar byte-idéntica, y las
 * DOS variantes conocidas quedan pineadas explícitamente como intencionales —
 * verify-claims-lib (null-safe: `s && s.length`) y workflow-factory (loguea cuando trunca).
 * Si aparece una tercera variante, o una de estas dos cambia, el guard falla y obliga a decidir
 * a propósito (actualizar el pin o unificar), no por accidente de copy-paste.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLDS = path.resolve(__dirname, "..", "..", "..", "scaffolds");

const { check, counts } = createChecker();

const STANDARD = `const compact = (d, n = 60000) => {
		const s = typeof d === "string" ? d : JSON.stringify(d);
		return s.length > n ? \`\${s.slice(0, n)} …[truncated]\` : s;
	};`;

const KNOWN_VARIANTS = {
	// null-safe: los claims llegan de input externo y pueden ser undefined.
	"verify-claims-lib.js": `const compact = (d, n = 60000) => {
		const s = typeof d === "string" ? d : JSON.stringify(d);
		return s && s.length > n ? \`\${s.slice(0, n)} …[truncated]\` : s;
	};`,
	// el meta-scaffold loguea el clamp (regla pandi 5: los clamps nunca son silenciosos).
	"workflow-factory.js": `const compact = (d, n = 60000) => {
		const s = typeof d === "string" ? d : JSON.stringify(d);
		if (s.length > n) {
			log(\`compacted payload \${JSON.stringify({ from: s.length, to: n })}\`);
			return \`\${s.slice(0, n)} …[truncated]\`;
		}
		return s;
	};`,
};

function extractCompact(source) {
	const start = source.indexOf("const compact = ");
	if (start < 0) return null;
	// La copia termina en la primera línea "};" con la misma indentación del arranque.
	const end = source.indexOf("\n\t};", start);
	return end < 0 ? null : source.slice(start, end + "\n\t};".length).replace(/\n\t/g, "\n\t").trim();
}

const files = fs
	.readdirSync(SCAFFOLDS)
	.filter((f) => f.endsWith(".js"))
	.sort();
check("el catálogo de scaffolds está donde se espera", files.length >= 24, `${files.length} archivos en ${SCAFFOLDS}`);

let standard = 0;
for (const file of files) {
	const source = fs.readFileSync(path.join(SCAFFOLDS, file), "utf8");
	const copy = extractCompact(source);
	if (copy == null) {
		check(`${file}: si no define compact, tampoco lo usa`, !/\bcompact\(/.test(source), file);
		continue;
	}
	const expected = KNOWN_VARIANTS[file];
	if (expected) {
		check(`${file}: la variante intencional de compact coincide con el pin`, copy === expected.trim(), copy);
	} else {
		check(`${file}: compact es byte-idéntico a la forma estándar`, copy === STANDARD.trim(), copy);
		if (copy === STANDARD.trim()) standard++;
	}
}
check("la forma estándar cubre el resto del catálogo (23 copias)", standard === 23, String(standard));

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
