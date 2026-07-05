/**
 * Núcleo de replay de session-state, local a esta extensión para que siga siendo autocontenida.
 *
 * DUPLICACIÓN INTENCIONAL: vive una copia byte-idéntica en cada una de las
 * extensiones loop/goal/plan que la necesitan, en vez de un import
 * cross-extension `../shared/`. Pi carga cada extensión de forma autocontenida
 * (un solo archivo o un directorio con sus PROPIOS helpers, vía resolución de
 * filesystem de jiti), así que un import `../shared/` solo resuelve mientras
 * todo el paquete está co-instalado y se rompe bajo distribución por extensión.
 * Mantené las copias sincronizadas a mano.
 *
 * Acá vive solo la recolección PURA latest-by-key; la lógica divergente de
 * recuperación que corre después (gating active-vs-terminal, resolución de
 * conflictos del sidecar, retiro autónomo, re-arming) queda en el index.ts de
 * cada extensión porque esas sí son máquinas de estado realmente distintas, no
 * duplicación.
 *
 * El parámetro entry es estructural (PersistedEntry), así que esto no se acopla
 * a un tipo específico de entry del SDK.
 */

/** Forma estructural de una entrada de sesión que inspecciona este núcleo. */
export interface PersistedEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Construye un Map del último snapshot por clave a partir de session entries
 * append-only, conservando solo las entradas cuyo type es "custom", cuyo
 * customType coincide y cuya clave extraída es un string. Gana la última
 * escritura (las entradas se recorren en orden; Map.set sobreescribe). Es
 * idéntico en comportamiento al loop inline que reemplaza.
 *
 * @param entries    session entries en orden de append (oldest -> newest)
 * @param customType el discriminador customType de appendEntry (e.g. "loop-state")
 * @param keyOf      extrae el id usado como clave del Map (debe ser un string para conservarse)
 */
export function collectLatestByKey<T>(
	entries: Iterable<PersistedEntry>,
	customType: string,
	keyOf: (data: T) => unknown,
): Map<string, T> {
	const latest = new Map<string, T>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as T | undefined;
		if (!data) continue;
		const key = keyOf(data);
		if (typeof key !== "string") continue;
		latest.set(key, data);
	}
	return latest;
}
