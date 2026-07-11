import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INDEX_FILE, normalizeNote, slugifyTopic, upsertMemoryNote } from "./memory.js";
import { indexPathOf, legacyPathOf, memoryDirOf } from "./paths.js";
import { toolError, toolSuccess } from "./tool-results.js";

export type RememberParams = {
	note: string;
	topic?: string;
};

export function executeRemember(params: RememberParams, ctx: ExtensionContext) {
	const note = normalizeNote(params.note);
	if (!note) {
		return toolError("Nada para recordar: la nota quedó vacía después de recortar espacios.");
	}

	const memoryDir = memoryDirOf(ctx.cwd);
	const indexPath = indexPathOf(ctx.cwd);
	const legacyPath = legacyPathOf(ctx.cwd);

	const rawTopic = params.topic?.trim();
	let targetPath = indexPath;
	let targetLabel = `${CONFIG_DIR_NAME}/memory/MEMORY.md`;
	const isIndex = !rawTopic;
	if (rawTopic) {
		const slug = slugifyTopic(rawTopic);
		if (!slug) {
			return toolError(
				`Topic inválido "${params.topic}": no se pudo derivar un nombre de archivo seguro — usá letras, números o guiones.`,
			);
		}
		if (slug === INDEX_FILE.replace(/\.md$/i, "").toLowerCase()) {
			return toolError(
				`Topic reservado "${params.topic}": usarlo colisionaría con el índice inyectado ${CONFIG_DIR_NAME}/memory/${INDEX_FILE}; elegí otro nombre.`,
			);
		}
		targetPath = join(memoryDir, `${slug}.md`);
		targetLabel = `${CONFIG_DIR_NAME}/memory/${slug}.md`;
	}

	let existing = "";
	try {
		if (existsSync(targetPath)) {
			existing = readFileSync(targetPath, "utf8");
		} else if (isIndex && existsSync(legacyPath)) {
			existing = readFileSync(legacyPath, "utf8");
		}
	} catch {
		return toolError(
			`No se pudo leer la memoria existente en ${targetPath}; no se escribió nada — verificá que el archivo exista y sea legible, y reintentá.`,
			{ path: targetPath },
		);
	}

	const date = new Date().toISOString().slice(0, 10);
	const { content, added } = upsertMemoryNote(existing, note, date);
	if (!added) {
		return toolSuccess(`Ya está en memoria (no-op): "${note}"`, {
			remembered: false,
			duplicate: true,
			path: targetPath,
		});
	}
	try {
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(targetPath, content, "utf8");
	} catch (err) {
		return toolError(`No se pudo escribir la memoria en ${targetPath}: ${(err as Error).message}`, {
			path: targetPath,
		});
	}
	return toolSuccess(`Recordado (guardado en ${targetLabel}): "${note}"`, {
		remembered: true,
		path: targetPath,
		topic: rawTopic ? targetLabel : null,
	});
}
