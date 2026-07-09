#!/usr/bin/env node
/**
 * Caracteriza los frames observables del indicador animado de `index.ts`.
 * Protege las dos familias del estilo `claude`, la duración de cada ciclo y el movimiento
 * que distingue al indicador de un estado estático.
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

// El stub hace visible el color como tags y conserva los escapes que usan los ojos.
const fakeTheme = {
	fg: (role, value) => `<${role}>${value}</${role}>`,
	getFgAnsi: (role) => (role === "success" ? "\x1b[32m" : "\x1b[35m"),
};

const KAOMOJI_STYLE_FACES = {
	kaomoji: "ʕ •ᴥ• ʔ",
	ojitos: "ʕ ◕ᴥ◕ ʔ",
	decidido: "ʕ •̀ᴥ•́ ʔ",
	gatuno: "(=◕ᴥ◕=)",
};

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
		"claude indicator includes the bear kaomoji",
		visible.includes("ʕ") && visible.includes("ᴥ") && visible.includes("ʔ"),
		visible,
	);
	check("bear kaomoji uses the requested visible shape", visible.includes("ʕ •ᴥ• ʔ"), visible);

	const families = frames.map(faceFamily);
	const familyRuns = runs(families);
	check(
		"claude indicator shows one face family at a time before switching",
		familyRuns.length === 2 && familyRuns.every((run) => run.length >= 4),
		JSON.stringify(familyRuns),
	);
	check(
		"each face family has its own movement before the next one appears",
		["classic", "bear"].every(
			(family) => new Set(frames.filter((frame) => faceFamily(frame) === family).map(visibleText)).size >= 4,
		),
		JSON.stringify(
			Object.fromEntries(
				["classic", "bear"].map((family) => [
					family,
					new Set(frames.filter((frame) => faceFamily(frame) === family).map(visibleText)).size,
				]),
			),
		),
	);
	const familyFrameRuns = frameRunsByFamily(frames);
	check(
		"each face family stays for at least 3 full animation cycles before switching",
		familyFrameRuns.length === 2 && familyFrameRuns.every((run) => repeatsFirstCycleAtLeast(run.frames, 3)),
		JSON.stringify(
			Object.fromEntries(
				familyFrameRuns.map((run) => [
					run.family,
					{ frames: run.frames.length, unique: new Set(run.frames.map(visibleText)).size },
				]),
			),
		),
	);
	check("indicator has multiple animation frames", new Set(frames).size >= 6, `unique=${new Set(frames).size}`);
	check(
		"indicator keeps progress-dot movement",
		frames.some((frame) => visibleText(frame).includes("...")),
	);

	for (const [style, expectedFace] of Object.entries(KAOMOJI_STYLE_FACES)) {
		const styleFrames = mod.pandaFrames(fakeTheme, style).frames ?? [];
		const visibleFrames = styleFrames.map(visibleText);
		check(`${style} indicator keeps its characteristic face`, visibleFrames[0] === expectedFace, visibleFrames[0]);
		check(
			`${style} indicator keeps animated progress movement`,
			new Set(visibleFrames).size >= 6 && visibleFrames.some((frame) => frame.includes("...")),
			JSON.stringify(visibleFrames),
		);
	}
}

function visibleText(value) {
	return String(value).replace(ANSI_RE, "").replace(TAG_RE, "");
}

function faceFamily(frame) {
	const visible = visibleText(frame);
	if (visible.includes("ʕ") && visible.includes("ʔ")) return "bear";
	if (visible.includes("(") && visible.includes(")")) return "classic";
	return "unknown";
}

function runs(values) {
	const result = [];
	for (const value of values) {
		const last = result.at(-1);
		if (last?.value === value) last.length += 1;
		else result.push({ value, length: 1 });
	}
	return result;
}

function frameRunsByFamily(frames) {
	const result = [];
	for (const frame of frames) {
		const family = faceFamily(frame);
		const last = result.at(-1);
		if (last?.family === family) last.frames.push(frame);
		else result.push({ family, frames: [frame] });
	}
	return result;
}

function repeatsFirstCycleAtLeast(frames, minCycles) {
	const visibleFrames = frames.map(visibleText);
	const cycleLength = new Set(visibleFrames).size;
	if (cycleLength === 0 || visibleFrames.length < cycleLength * minCycles) return false;
	const cycle = visibleFrames.slice(0, cycleLength);
	for (let cycleIndex = 1; cycleIndex < minCycles; cycleIndex++) {
		const start = cycleIndex * cycleLength;
		if (!cycle.every((frame, i) => visibleFrames[start + i] === frame)) return false;
	}
	return true;
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
