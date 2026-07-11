# Frontera futura de proceso/OS para runners Ultracode

## Estado

Diseño exploratorio. No implementa aislamiento ni cambia el contrato actual: los runners de Claude, Codex y Cursor son
**trusted-workspace only**.

`node:vm` aporta un contexto de evaluación dentro del proceso host. Ni `node:vm` ni `worker_threads` son un sandbox de
seguridad. Un child process que corre con la misma identidad del usuario tampoco constituye, por sí solo, una frontera
de aislamiento OS.

## Threat model

La frontera futura debería proteger archivos, credenciales, variables de entorno, procesos y red del host frente a un
workflow malicioso o comprometido. El workflow puede invocar capacidades inyectadas y provocar subprocesos de workers;
por eso esos spawns también deben quedar dentro de la frontera elegida.

Quedan fuera del threat model actual los workflows no revisados: el flag `--trust-workspace` confirma una decisión
humana, no vuelve seguro el código.

## Opción A: child process con capability bridge

Mover la evaluación a un proceso hijo y exponer por IPC una API allowlist, versionada y deny-by-default:

- validar y limitar argumentos, tamaños, concurrencia y timeouts;
- filtrar entorno, directorio de trabajo y señales;
- conservar journal, cancelación y artifacts en el proceso coordinador;
- hacer explícita cada capacidad de filesystem, shell, red y spawn.

Esta opción mejora separación de fallas y auditabilidad. No permite ejecutar código hostil mientras el hijo conserve
acceso OS con la identidad del usuario. Para ese objetivo necesita controles adicionales del sistema operativo.

## Opción B: Gondolin

Ejecutar evaluación, capability bridge y workers dentro de una micro-VM Gondolin ofrece una frontera OS más fuerte. Debe
comprobarse que ningún spawn de Claude, Codex o Cursor escape al host y que sólo se compartan paths, credenciales y red
declarados.

El costo esperado es mayor: soporte de plataforma, arranque, distribución de CLIs y autenticación, transferencia de
artifacts, cancelación y diagnóstico. La referencia existente está en
[`docs/gondolin-isolation.md`](../gondolin-isolation.md).

## Criterios de decisión

- Fortaleza requerida: fallas accidentales de código confiable o código hostil.
- Capability bridge deny-by-default y trazabilidad de cada operación.
- Contención real de procesos hijos, filesystem, credenciales y red.
- Compatibilidad de plataforma y operación reproducible en CI.
- Latencia de arranque, throughput y límites de recursos.
- Preservación de artifacts, journal, resume, cancelación y observabilidad.
- Tests adversariales aislados de la suite normal y revisión de supply chain.

Usar child process si el objetivo probado es contener fallas y hacer explícitas las capacidades de workflows confiables.
Elegir Gondolin si el requisito es aceptar workflows no confiables con una frontera OS verificable.

## Non-goals

- Implementar cualquiera de las opciones en P1-01.
- Presentar `node:vm`, `worker_threads` o un child process simple como sandbox.
- Cambiar permisos o flags de los workers más allá del trust gate acordado.
- Resolver otros findings de seguridad o ampliar el alcance a P1-06.
