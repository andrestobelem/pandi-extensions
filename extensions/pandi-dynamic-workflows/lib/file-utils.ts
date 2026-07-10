/**
 * Utilidades de escritura de archivos transversales y sin estado de corrida.
 *
 * writeTextFileAtomic escribe a un temp sibling y renombra, evitando archivos
 * truncados si hay un crash a mitad de escritura.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";

export async function writeTextFileAtomic(file: string, content: string): Promise<void> {
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, content, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}
