/**
 * Abrir worktree: crear-si-falta + sesión nueva de Pi (Supacode tab o hint cd+pi).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isValidBranchName, resolveWorktreeTarget } from "./worktree.js";
import { addWorktree } from "./worktree-actions.js";

// La CLI de Supacode confirma `tab new` sobre el TTY controlador (OSC). Un proceso hijo
// lanzado sin TTY nunca recibe ese ack y el comando agota el tiempo — AUNQUE la
// pestaña se crea. Por eso generamos el id de pestaña nosotros (`tab new -n`) y
// confirmamos la creación con `tab list` (una lectura que funciona sobre el socket),
// en vez de confiar en el exit code o stdout de `tab new`.
const SUPACODE_LIST_TIMEOUT_MS = 5_000;
const SUPACODE_VERIFY_TIMEOUT_MS = 5_000;
const SUPACODE_VERIFY_DELAY_MS = 350;

/** Verdadero cuando se ejecuta dentro de una terminal Supacode (que puede abrir una pestaña nueva). */
function isSupacode(): boolean {
	return process.env.TERM_PROGRAM === "supacode" || Boolean(process.env.SUPACODE_SOCKET_PATH);
}

/** Envuelve una cadena en comillas simples POSIX para que sea segura dentro de un comando shell. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Ejecuta un subcomando `supacode` con un array argv (nunca una cadena de
 * shell). Nunca rechaza: fallo de spawn, salida no cero, timeout y abort
 * resuelven todos a un resultado tipado. `spawnFailed` marca un binario ausente
 * o roto (evento 'error' del proceso hijo) para que quien llama pueda distinguirlo del timeout de
 * ack esperado de `tab new`.
 */
function runSupacode(
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; spawnFailed: boolean; error?: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn("supacode", args, { windowsHide: true });
		const finish = (result: { ok: boolean; stdout: string; spawnFailed: boolean; error?: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			try {
				child.kill("SIGKILL");
			} catch {
				/* ya no está */
			}
			resolve(result);
		};
		const onAbort = (): void => finish({ ok: false, stdout, spawnFailed: false, error: "abortado" });
		const timer = setTimeout(
			() => finish({ ok: false, stdout, spawnFailed: false, error: "supacode agotó el tiempo de espera" }),
			timeoutMs,
		);
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort);
		}
		child.stdout?.on("data", (d) => {
			stdout += String(d);
		});
		child.stderr?.on("data", (d) => {
			stderr += String(d);
		});
		child.on("error", (err) => finish({ ok: false, stdout, spawnFailed: true, error: err.message }));
		child.on("close", (code) =>
			finish({
				ok: code === 0,
				stdout,
				spawnFailed: false,
				error: code === 0 ? undefined : stderr.trim() || `supacode salió con el código ${code}`,
			}),
		);
	});
}

/**
 * Abre una sesión nueva de Pi en una pestaña de Supacode cuyo shell arranca en
 * `cwd`. El id de pestaña se genera acá y se pasa por `tab new -n`, luego se
 * confirma con `tab list`, así que el resultado es correcto aunque `tab new`
 * agote el tiempo esperando un TTY ack que nunca puede recibir (la pestaña igual
 * se crea). El único texto evaluado por shell es la entrada `-i`, donde el path
 * va entre comillas simples.
 */
async function openSupacodeTab(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; tabId?: string; error?: string }> {
	const tabId = randomUUID().toUpperCase();
	const input = `cd ${shellQuote(cwd)} && exec pi`;
	// Sin esperar: esta llamada queda colgada ~10s por el ack faltante, así que no
	// la esperamos. Conservamos el handle para detectar un fallo de spawn y matar al
	// rezagado cuando la pestaña quede confirmada.
	const create = spawn("supacode", ["tab", "new", "-n", tabId, "-i", input], { windowsHide: true });
	let spawnError: string | undefined;
	create.on("error", (err) => {
		spawnError = err.message;
	});
	create.stdout?.resume();
	create.stderr?.resume();
	try {
		const deadline = Date.now() + SUPACODE_VERIFY_TIMEOUT_MS;
		do {
			if (signal?.aborted) return { ok: false, error: "abortado" };
			if (spawnError) return { ok: false, error: spawnError };
			const list = await runSupacode(["tab", "list"], SUPACODE_LIST_TIMEOUT_MS, signal);
			if (list.spawnFailed) return { ok: false, error: list.error ?? "no se pudo ejecutar supacode" };
			if (list.ok && list.stdout.toUpperCase().includes(tabId)) return { ok: true, tabId };
			await delay(SUPACODE_VERIFY_DELAY_MS, signal);
		} while (Date.now() < deadline);
		return { ok: false, error: spawnError ?? "supacode no informó la nueva pestaña a tiempo" };
	} finally {
		try {
			create.kill("SIGKILL");
		} catch {
			/* ya no está */
		}
	}
}

export interface OpenOptions {
	path?: string;
	newBranch?: string;
	commitish?: string;
	detach?: boolean;
	force?: boolean;
	copyIgnored?: boolean;
	copyUntracked?: boolean;
}

export interface OpenOutcome {
	ok: boolean;
	path: string;
	created: boolean;
	opened: boolean;
	tabId?: string;
	message: string;
	isError?: boolean;
}

/**
 * Resuelve un target de worktree, lo crea cuando su directorio todavía no
 * existe y luego inicia una sesión NUEVA de Pi en él (una pestaña nueva de
 * Supacode cuando está disponible; si no, informa el comando `cd <path> && pi`).
 * El cwd de la sesión actual nunca cambia. Lo comparten el comando /worktree
 * open y la herramienta git_worktree.
 */
export async function openWorktree(
	ctx: ExtensionContext,
	opts: OpenOptions,
	signal?: AbortSignal,
): Promise<OpenOutcome> {
	const target = resolveWorktreeTarget(opts.path ?? "", ctx.cwd);
	if (!target) {
		return {
			ok: false,
			path: "",
			created: false,
			opened: false,
			isError: true,
			message: "La acción 'open' requiere 'path'.",
		};
	}
	if (opts.newBranch !== undefined && !isValidBranchName(opts.newBranch)) {
		return {
			ok: false,
			path: target.path,
			created: false,
			opened: false,
			isError: true,
			message: `Nombre de rama inválido "${opts.newBranch}" — sin espacios, caracteres de control ni puntos o barras iniciales/finales.`,
		};
	}
	let created = false;
	let copySuffix = "";
	if (!existsSync(target.path)) {
		const added = await addWorktree(
			ctx,
			{
				path: opts.path,
				newBranch: opts.newBranch,
				commitish: opts.commitish,
				detach: opts.detach,
				force: opts.force,
				copyIgnored: opts.copyIgnored,
				copyUntracked: opts.copyUntracked,
			},
			signal,
		);
		if (!added.ok) {
			return {
				ok: false,
				path: added.path || target.path,
				created: false,
				opened: false,
				isError: true,
				message: added.message,
			};
		}
		created = true;
		copySuffix = added.copySuffix;
	}
	const state = created ? "creado" : "listo";
	const openHint = `cd ${target.path} && pi`;
	if (!isSupacode()) {
		return {
			ok: true,
			path: target.path,
			created,
			opened: false,
			message: `Worktree ${state} en ${target.path}${copySuffix}. Abrilo con: ${openHint}`,
		};
	}
	const tab = await openSupacodeTab(target.path, signal);
	if (!tab.ok) {
		return {
			ok: true,
			path: target.path,
			created,
			opened: false,
			message: `Worktree ${state} en ${target.path}${copySuffix}, pero no se pudo abrir una pestaña de Supacode: ${tab.error}. Abrilo con: ${openHint}`,
		};
	}
	return {
		ok: true,
		path: target.path,
		created,
		opened: true,
		tabId: tab.tabId,
		message: `Se abrió Pi en una pestaña nueva de Supacode${tab.tabId ? ` (${tab.tabId})` : ""} en ${target.path}${created ? " (worktree nuevo)" : ""}${copySuffix}.`,
	};
}
