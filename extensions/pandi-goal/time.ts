/**
 * Helper de formateo de tiempo, local a esta extensión para que siga siendo autocontenida.
 *
 * DUPLICACIÓN INTENCIONAL: vive una copia byte-idéntica en cada extensión que
 * la necesita (hoy pandi-loop y pandi-goal), en vez de un import cross-extension
 * `../shared/`. Pi carga cada extensión de forma autocontenida —un solo archivo
 * o un directorio con sus PROPIOS helpers—, así que meterse en el directorio de
 * una extensión hermana solo resuelve mientras todo el paquete está
 * co-instalado y se rompe bajo cualquier distribución por extensión. La función
 * es chica y estable; mantené las copias sincronizadas a mano.
 */

/**
 * Etiqueta legible del tiempo hasta el próximo disparo para una línea de estado.
 *
 * - `null`      -> "now" (sin wake programado)
 * - < 60s       -> "<n>s"
 * - >= 60s      -> "<n>m" (redondeado a minutos enteros)
 *
 * Nunca devuelve un valor negativo: los timestamps pasados se limitan a 0.
 */
export function formatEta(nextFireAt: number | null): string {
	if (nextFireAt === null) return "now";
	const secs = Math.max(0, Math.round((nextFireAt - Date.now()) / 1000));
	if (secs >= 60) return `${Math.round(secs / 60)}m`;
	return `${secs}s`;
}
