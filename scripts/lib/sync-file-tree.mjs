import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Lista recursivamente los archivos bajo `dir` como paths relativos a `dir` (ordenados, estilo POSIX en este repo).
export async function listFilesRec(dir, base = dir) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return out;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFilesRec(full, base)));
		else out.push(relative(base, full));
	}
	return out;
}

export async function readMaybe(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return null;
	}
}

// Describe el drift sin imponer cómo reportarlo ni cómo reemplazar el árbol destino.
export async function findFileTreeDrift(expected, root) {
	const drift = [];
	for (const [relativePath, want] of expected) {
		if ((await readMaybe(join(root, relativePath))) !== want) {
			drift.push({ kind: "mismatch", relativePath });
		}
	}
	for (const relativePath of await listFilesRec(root)) {
		if (!expected.has(relativePath)) drift.push({ kind: "stale", relativePath });
	}
	return drift;
}
