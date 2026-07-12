import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function readJsonFile(file, options = {}) {
	const { fallback, onError = "throw" } = options;
	if (fallback !== undefined && !existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if (onError === "null") return null;
		throw error;
	}
}

export function writeJsonFile(file, value) {
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

export function sameJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}
