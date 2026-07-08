/**
 * Canary de superficie del SDK real (hallazgo test-review P1).
 *
 * Cada suite de integración bundlea su extensión contra stubs ESCRITOS A MANO de los paquetes SDK
 * (harness.mjs STUB_SOURCES / sdkStub), así que "125/125 green" no prueba si los paquetes REALES
 * @earendil-works todavía exponen la superficie que las extensiones importan en runtime. Los stubs
 * pueden derivar silenciosamente de la realidad (p. ej. `convertToLlm` lo usa una extensión pero ni siquiera
 * está en el sdk stub default), y solo `tsc` cruza contra los *types* reales — no los valores runtime.
 *
 * Este canary importa los paquetes REALES instalados y aserta que cada valor RUNTIME del que dependen
 * las extensiones existe con el `typeof` esperado, así un upgrade SDK rompedor (un export renombrado/removido
 * o un valor que cambió de kind) falla ACÁ en vez de recién en producción.
 *
 * Refrescá el mapa SURFACE cuando una extensión empiece a importar un nuevo valor runtime:
 *   grep -rhoE 'import \{[^}]+\} from "@earendil-works/[^"]+"' extensions/*\/*.ts
 * Los imports type-only se borran en runtime (cubiertos por tsc), así que intencionalmente NO se listan.
 *
 * Corrida:
 *   node extensions/pandi-dynamic-workflows/tests/integration/sdk-surface-canary.test.mjs
 */

import { createChecker } from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

// Valores runtime importados desde @earendil-works/* en extensions/*/*.ts, con su kind esperado
// (una clase es `typeof === "function"`; un const string es "string"; un namespace object es "object").
const SURFACE = {
	"@earendil-works/pi-coding-agent": {
		CONFIG_DIR_NAME: "string",
		getAgentDir: "function",
		convertToLlm: "function",
		CustomEditor: "function", // clase
	},
	"@earendil-works/pi-ai": {
		StringEnum: "function",
	},
	"@earendil-works/pi-ai/compat": {
		completeSimple: "function",
	},
	"@earendil-works/pi-tui": {
		Image: "function", // clase (importada como TerminalImage)
		Key: "object",
		Markdown: "function", // clase
		getCapabilities: "function",
		matchesKey: "function",
		truncateToWidth: "function",
		visibleWidth: "function",
	},
};

// Predicado puro: los nombres de `expected` que faltan en `mod` o tienen `typeof` incorrecto.
function surfaceMismatches(mod, expected) {
	const out = [];
	for (const [name, kind] of Object.entries(expected)) {
		const actual = typeof mod?.[name];
		if (actual !== kind) out.push(`${name}: expected ${kind}, got ${actual}`);
	}
	return out;
}

async function main() {
	// No-vacuidad: el predicado debe FALLAR ante un export missing / wrong-kind y PASAR ante uno presente,
	// así los checks de real-import de abajo no pueden quedar verdes trivialmente.
	check("predicate flags a missing export", surfaceMismatches({}, { foo: "function" }).length === 1);
	check("predicate flags a wrong-kind export", surfaceMismatches({ foo: 1 }, { foo: "function" }).length === 1);
	check("predicate passes a present export", surfaceMismatches({ foo: () => {} }, { foo: "function" }).length === 0);

	for (const [specifier, expected] of Object.entries(SURFACE)) {
		let mod;
		try {
			mod = await import(specifier);
		} catch (err) {
			check(`real ${specifier} imports`, false, String(err));
			continue;
		}
		const miss = surfaceMismatches(mod, expected);
		check(`real ${specifier} exposes the runtime surface extensions import`, miss.length === 0, miss.join("; "));
	}

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

await main();
