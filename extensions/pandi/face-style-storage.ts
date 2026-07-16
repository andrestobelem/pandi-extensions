import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FaceStyle, parseFaceStyle } from "./face.js";

function styleFile(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "pandi-style.local.json");
}

export function loadFaceStyle(): FaceStyle {
	try {
		return parseFaceStyle((JSON.parse(readFileSync(styleFile(), "utf8")) as { face?: unknown }).face);
	} catch {
		return "claude";
	}
}

export function saveFaceStyle(face: FaceStyle): boolean {
	try {
		writeFileSync(styleFile(), JSON.stringify({ face }));
		return true;
	} catch {
		return false;
	}
}
