#!/usr/bin/env node
/**
 * Test conductual para el indicador animado de Pandi (extensions/pandi/index.ts).
 *
 * Contrato de esta suite:
 * - el estilo default/claude conserva la carita clásica con paréntesis;
 * - también alterna con el osito `ʕ •ᴥ• ʔ` pedido para darle más vida;
 * - la animación mantiene movimiento observable (frames distintos y puntitos de progreso).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const TAG_RE = /<[^>]+>/g;

const fakeTheme = {
	fg: (role, value) => `<${role}>${value}</${role}>`,
	getFgAnsi: (role) => (role === "success" ? "\x1b[32m" : "\x1b[35m"),
};

const visibleText = (value) => String(value).replace(ANSI_RE, "").replace(TAG_RE, "");

async function scenario(url) {
	const mod = await loadModule(url);
	check("pandaFrames is exported for indicator characterization", typeof mod.pandaFrames === "function");
	if (typeof mod.pandaFrames !== "function") return;

	const indicator = mod.pandaFrames(fakeTheme, "claude");
	const frames = indicator.frames ?? [];
	const visible = visibleText(frames.join("\n"));

	check(
		"claude indicator keeps the classic parenthesized face",
		visible.includes("(") && visible.includes(")"),
		visible,
	);
	check(
		"claude indicator alternates with the bear kaomoji",
		visible.includes("ʕ") && visible.includes("ᴥ") && visible.includes("ʔ"),
		visible,
	);
	check("bear kaomoji uses the requested visible shape", visible.includes("ʕ •ᴥ• ʔ"), visible);
	check("indicator has multiple animation frames", new Set(frames).size >= 6, `unique=${new Set(frames).size}`);
	check(
		"indicator keeps progress-dot movement",
		frames.some((frame) => visibleText(frame).includes("...")),
	);
}

async function main() {
	const built = await buildExtension({
		name: "pi-pandi-indicator",
		src: path.join(REPO_ROOT, "extensions", "pandi", "index.ts"),
		outName: "pandi.mjs",
		stubs: { sdk: "export {};\n" },
	});
	try {
		await scenario(built.url);
	} finally {
		await fs.rm(built.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
