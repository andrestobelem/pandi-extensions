/**
 * Helpers puros de liveness/identidad de procesos para `/bg`.
 *
 * Este slice NO depende del map activeJobs ni de otro estado mutable de módulo: dado un pid
 * (y opcionalmente un start id registrado), inspecciona el SO para etiquetar si un proceso
 * está vivo y si sigue siendo NUESTRO job. Separado para que la lógica de proyección read-time
 * en index.ts se mantenga enfocada en job state.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type Liveness = "alive" | "dead" | "unknown";

// Chequeo de liveness sincrónico de mejor esfuerzo. process.kill(pid, 0) NO envía señal; solo
// pregunta al SO si existe un proceso con ese pid. Cross-platform (Windows incluido). NOTE: un
// pid puede reutilizarse después de que el proceso original fue reaped, así que "alive" significa
// "algún proceso tiene este pid", no "nuestro job sigue corriendo"; por eso solo usamos esto
// para ETIQUETAR una lectura, nunca para enviar señal a un pid persistido.
// Un pid que realmente podemos probar: entero positivo. Excluye undefined, 0, negativos
// (p. ej. ids de process-group) y no enteros.
function isUsablePid(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

function parseLinuxProcStartId(stat: string): string | undefined {
	// comm puede contener espacios/parens, así que parsea campos después del último ')'.
	// starttime es el campo 22 (1-indexed) => índice 19 de los tokens post-comm.
	const afterComm = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	const starttime = afterComm[19];
	return starttime ? `lin:${starttime}` : undefined;
}

// Captura una identidad de inicio estable por proceso para que una prueba posterior distinga el
// proceso de nuestro job de otro no relacionado que reutilizó su pid. Mejor esfuerzo, con
// degradación entre plataformas: Linux lee /proc (sin subprocess); macOS/BSD ejecuta
// `ps -o lstart=`; cualquier otra cosa (p. ej. Windows) devuelve undefined y quienes llaman caen
// al label de liveness de mejor esfuerzo existente.
export function readProcessStartId(pid: number | undefined): string | undefined {
	if (!isUsablePid(pid)) return undefined;
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return parseLinuxProcStartId(stat);
		}
		if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
			const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
			const out = res.status === 0 ? (res.stdout ?? "").trim() : "";
			return out ? `ps:${out}` : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// Confirma que un pid vivo todavía pertenece a NUESTRO job comparando su identidad de inicio
// actual con la registrada en spawn. "same" = proceso verificado; "different" = el pid fue
// reutilizado (nuestro proceso terminó); "unknown" = no se puede saber (sin id registrado, o id
// actual ilegible) => quienes llaman mantienen comportamiento de mejor esfuerzo y nunca afirman reutilización.
export function verifyProcessIdentity(
	pid: number | undefined,
	recordedStartId: string | undefined,
): "same" | "different" | "unknown" {
	if (!recordedStartId) return "unknown";
	const current = readProcessStartId(pid);
	if (current === undefined) return "unknown";
	return current === recordedStartId ? "same" : "different";
}

export function probeProcessAlive(pid: number | undefined): Liveness {
	if (!isUsablePid(pid)) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") return "alive"; // existe pero pertenece a otro usuario
		if (code === "ESRCH") return "dead"; // no existe tal proceso
		return "unknown";
	}
}
