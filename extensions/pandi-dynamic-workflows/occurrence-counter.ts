/**
 * Índice determinista de ocurrencia por key para la resume cache content-addressed.
 *
 * Extraído textualmente de los antiguos `nextOcc`/`occCounters` anidados de runWorkflow. Misma key
 * (args de llamada idénticos) → 0, 1, 2, …; keys distintas cuentan independientemente. `next()` DEBE
 * llamarse en orden síncrono de emisión: ese orden hace determinista a `occ` (y por lo tanto
 * a los lookups de resume-cache).
 *
 * Intencionalmente PURO y sin mutex: la serialización vive en `occAssignMutex` de runWorkflow,
 * que envuelve TODO el prólogo de asignación de occ (resolución persona/access + cómputo de key
 * + esta llamada), no solo el incremento del counter. Reintroducir un lock acá achicaría esa
 * sección crítica y cambiaría el orden de resume-cache, así que esto queda como counter plano
 * y el caller es dueño del mutex.
 */
export class OccurrenceCounter {
	private readonly counters = new Map<string, number>();

	/** Siguiente índice de ocurrencia para `key`: misma key → 0, 1, 2, …; keys distintas son independientes. */
	next(key: string): number {
		const occ = this.counters.get(key) ?? 0;
		this.counters.set(key, occ + 1);
		return occ;
	}
}
