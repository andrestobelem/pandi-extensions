#!/usr/bin/env node
// Exporta una sesión de Pi a HTML en .pi/chats/ (directorio gitignored de chats del repo).
//
// El `/export` integrado de Pi escribe el HTML en el directorio de trabajo actual y
// no tiene una opción para un directorio de destino por defecto. Este helper vuelve
// real y repetible la convención "los chats viven en .pi/chats/" delegando al
// CLI soportado `pi --export <in> <out>` y escribiendo la salida ahí.
//
// Uso:
//   node scripts/export-chat.mjs                 # exporta la sesión más reciente
//   node scripts/export-chat.mjs <session.jsonl> # exporta un archivo de sesión específico
//
// El nombre de salida replica el export nativo de Pi: pi-session-<sessionBasename>.html

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const SESSIONS_DIR = join(REPO_ROOT, ".pi", "sessions");
const CHATS_DIR = join(REPO_ROOT, ".pi", "chats");

export function latestSessionFile(sessionsDir = SESSIONS_DIR) {
	if (!existsSync(sessionsDir)) return null;
	const jsonls = readdirSync(sessionsDir)
		.filter((n) => n.endsWith(".jsonl"))
		.map((n) => join(sessionsDir, n))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return jsonls[0] ?? null;
}

export function chatExportPath(sessionFile, chatsDir = CHATS_DIR) {
	return join(chatsDir, `pi-session-${basename(sessionFile, ".jsonl")}.html`);
}

// Resuelve el archivo de sesión: si hay un argumento explícito, gana; si no, usa el
// *.jsonl modificado más recientemente en .pi/sessions/ (o sea, la sesión actual/última).
function resolveSessionFile(arg) {
	if (arg) {
		const p = resolve(arg);
		if (!existsSync(p)) {
			console.error(`Session file not found: ${p}`);
			process.exit(1);
		}
		return p;
	}
	if (!existsSync(SESSIONS_DIR)) {
		console.error(`No sessions directory at ${SESSIONS_DIR}`);
		process.exit(1);
	}
	const latest = latestSessionFile(SESSIONS_DIR);
	if (!latest) {
		console.error(`No .jsonl sessions found in ${SESSIONS_DIR}`);
		process.exit(1);
	}
	return latest;
}

function main() {
	const sessionFile = resolveSessionFile(process.argv[2]);
	const outPath = chatExportPath(sessionFile, CHATS_DIR);

	mkdirSync(CHATS_DIR, { recursive: true });

	const result = spawnSync("pi", ["--export", sessionFile, outPath], { stdio: "inherit" });
	if (result.error) {
		console.error(`Failed to run pi --export: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
	console.log(`Chat exported to ${outPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
