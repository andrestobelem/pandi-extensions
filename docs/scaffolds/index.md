# Workflow scaffolds

Un scaffold es un patrón ejecutable del catálogo de pi-dynamic-workflows: una plantilla de workflow lista para instanciar (agentes, paralelismo, loops, votación, etc.) que resuelve una forma recurrente de tarea. Esta carpeta documenta cada scaffold disponible.

## Gate, ruteo y guardas

- [`contract-gate`](./contract-gate.md): Convierte un pedido vago en un contrato inspeccionable y decide preguntar-ahora vs proceder con un supuesto registrado.
- [`guardrails`](./guardrails.md): Tripwire barato de entrada/salida que se DETIENE ante una violación clara; puede envolver cualquier workflow vía protect:{name,args}.
- [`router`](./router.md): Clasifica un pedido y lo despacha al único workflow del catálogo más adecuado, o solo lo recomienda.

## Composición y meta

- [`orchestrator-workers`](./orchestrator-workers.md): Un planificador descompone una meta abierta en un grafo de subtareas (dependsOn); los workers ejecutan nivel por nivel; un integrador combina.
- [`composition-driver`](./composition-driver.md): Workflow padre: descubre afirmaciones, delega la verificación a verify-claims-lib y luego sintetiza.
- [`verify-claims-lib`](./verify-claims-lib.md): Sub-workflow reutilizable: verifica { claims, skeptics? } con jurados escépticos; devuelve verified/dropped/votes/coverage.
- [`workflow-factory`](./workflow-factory.md): Meta-workflow: catálogo → plan → generación → revisión → refinamiento, y luego escribe .pi/workflows/drafts/<slug>.js.
- [`recursive-compose`](./recursive-compose.md): Referencia (pi, profundidad ≤ 3): un nodo re-aplica contract-gate a una subtarea y luego despacha vía router — recursión acotada.

## Descubrimiento y fan-out

- [`fan-out-and-synthesize`](./fan-out-and-synthesize.md): Scatter-gather: explora una lista de trabajo, un revisor por ítem (paralelo, settle), sintetiza como juez con notas de cobertura/fallos.
- [`scout-fanout`](./scout-fanout.md): Scout más pipeline de profundidad adaptativa: clasifica el riesgo de cada archivo de forma barata, revisa a fondo solo alto/medio; el bajo riesgo corta camino.
- [`repo-bug-hunt`](./repo-bug-hunt.md): Explora archivos de código, revisores de bugs por archivo, un juez deduplica y prioriza con citas. Los hallazgos son pistas, no bugs confirmados.
- [`loop-until-dry`](./loop-until-dry.md): Sigue haciendo fan-out de buscadores hasta K rondas consecutivas silenciosas o maxRounds.
- [`react-scout`](./react-scout.md): Loop ReAct razonar → actuar → observar: cada paso ancla un pensamiento en una observación real de solo lectura antes del siguiente.

## Research

- [`complex-research`](./complex-research.md): Ángulos de investigación independientes (cada uno corre web search), sintetizados como juez con citas y brechas de cobertura.

## Verificación

- [`adversarial-verify`](./adversarial-verify.md): Jurado escéptico por hallazgo que poda por refutación mayoritaria; por defecto se duda.
- [`bug-verify`](./bug-verify.md): Confirma bugs sospechosos por REPRODUCCIÓN: es real solo si una corrida falla en el código actual; chequeo opcional de fix FAIL→PASS y minimización.
- [`adversarial-plan-review`](./adversarial-plan-review.md): N revisores de ángulo fijo (corrección, seguridad, mantenibilidad, alcance) sintetizan un plan revisado.

## Generar y seleccionar (best-of-N)

- [`judge-escalate`](./judge-escalate.md): Genera candidatos desde ángulos distintos, un juez tipado, y escala solo cuando la confianza es baja.
- [`tournament`](./tournament.md): Bracket de eliminación simple: rondas de juez por pares hasta que sobrevive un solo candidato.
- [`self-consistency`](./self-consistency.md): Muestrea N caminos de razonamiento independientes, elige por consenso (voto), desempatado por un juez que pondera evidencia.
- [`tree-of-thoughts`](./tree-of-thoughts.md): Búsqueda en haz sobre soluciones parciales: expande K pensamientos, los puntúa un juez, poda al top-B, recurre en profundidad, y confirma.

## Iterativos y de refinamiento

- [`self-refine`](./self-refine.md): Generar → criticar → refinar in situ y acotado, con memoria verbal; se detiene en silencio cuando el crítico queda satisfecho.
- [`reflexion`](./reflexion.md): Loop externo de intentos con RL verbal: reintenta cada intento cargando auto-reflexiones; el evaluador puede estar anclado externamente (verifyCmd).

## Migraciones y datos grandes

- [`large-migration`](./large-migration.md): Un aplicador real: gate de baseline en verde, por archivo aplica → verifica → repara acotado, con rollback ante fallo. Secuencial.
- [`map-reduce`](./map-reduce.md): Map-reduce jerárquico: map por chunk bajo un contrato de evidencia, reduce en lotes acotados hasta un resumen-de-resúmenes.
