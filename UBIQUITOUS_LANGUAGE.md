# Lenguaje ubicuo de pandi-extensions

## En 30 segundos

Este glosario separa conceptos que hoy aparecen mezclados en código y documentación. Usalo para hablar del producto,
describir una corrida o revisar un contrato sin confundir programa, motor, ejecución, actor ni evidencia.

Los nombres literales de comandos, tools y schema keys permanecen en inglés. Para su grafía exacta, consultá
[`glosario-skills.md`](docs/handbooks/glosario-skills.md) y
[`glosario-prompts.md`](docs/handbooks/glosario-prompts.md).

## Producto y distribución

| Término | Definición | Alias a evitar |
| --- | --- | --- |
| **Pi** | CLI upstream que carga extensiones, skills y temas, y hospeda la experiencia interactiva. | Pandi, Pandi CLI |
| **distribución Pandi** | Paquete raíz instalable de este repo para Pi, compuesto por extensiones Pi, skills y un tema. | extensión Pandi, suite de 28 extensiones |
| **persona Pandi** | Mascota y persona interactiva provista por la extensión literal `pandi`. | Pandi sin calificador en prosa técnica |
| **paquete** | Unidad npm publicable que puede contener una extensión, un tema o un host portable. | extensión como término genérico |
| **extensión Pi** | Punto de entrada cargado mediante `pi.extensions`. | paquete, tema, host portable |
| **tema Pi** | Recurso visual registrado mediante `pi.themes`, sin punto de entrada de extensión. | extensión Pi |
| **host portable** | Paquete externo que ejecuta workflows mediante Cursor, Claude o Codex sin iniciar Pi. | extensión Pi, runner |
| **runner portable** | Componente de un host portable que coordina la evaluación del workflow y las llamadas al CLI elegido. | host, Worker, subagente |

## Orquestación ejecutable

| Término | Definición | Alias a evitar |
| --- | --- | --- |
| **dynamic workflows** | Capacidad del producto para ejecutar orquestaciones multiagente observables y reanudables. | Ultracode, runtime, workflow |
| **`ultracode`** | Skill y política de routing que elige entre trabajo inline y un workflow según costo y riesgo. | dynamic workflows, runtime, runner |
| **workflow** | Programa JavaScript que declara una orquestación mediante globals inyectadas. | runtime, corrida, scaffold |
| **runtime de workflows** | Motor que resuelve, valida y ejecuta workflows, y administra sus corridas. | workflow, Ultracode |
| **patrón agéntico** | Forma conceptual reutilizable de organizar agentes, dependencias y síntesis. | scaffold |
| **scaffold** | Workflow ejecutable y de solo lectura que implementa un patrón o caso de uso del catálogo. | patrón, plantilla no ejecutable |
| **draft** | Workflow editable, específico de una tarea, normalmente derivado de un scaffold. | scaffold |
| **subworkflow** | Workflow compuesto mediante `workflow()` dentro de la misma corrida. | corrida hija, nested run |
| **corrida** | Ejecución identificable de un workflow con `runId`, directorio y estado propios. | workflow, job, run en prosa española |
| **job** | Proceso background local de `pandi-bg`, sin composición multiagente ni journal de reanudación. | corrida |
| **composition depth** | Niveles de `workflow()` dentro de una corrida; el contrato actual permite uno y solo el top-level compone. | nested-run depth |
| **nested-run depth** | Nuevas corridas top-level iniciadas desde subagentes; el guard de pi default-ea a 2 y es configurable. | composition depth |

## Actores y control

| Término | Definición | Alias a evitar |
| --- | --- | --- |
| **orquestador** | Agente o lógica que descompone, enruta y sintetiza trabajo delegado. | runner, Worker |
| **subagente** | Invocación acotada de un modelo o CLI lanzada por `agent()` o `agents()`. | Worker, runner |
| **Workflow Worker** | `Worker` de Node que evalúa el JavaScript del workflow y puentea llamadas al host. | subagente, runner |
| **persona** | Configuración de rol y prompt aplicada a un subagente. | agente, persona usuaria |
| **phase marker** | Evento de observabilidad emitido por `phase(label)`. | estado de workflow, fase de fan-out |
| **fase de fan-out** | Identidad asignada a un lote de `agents()` para agrupar sus subagentes. | phase marker |
| **señal de cancelación** | Notificación `AbortSignal` que solicita detener trabajo sin demostrar que ya terminó. | cancelación efectiva |
| **cancelación de rama** | Propagación cooperativa de la señal de una rama perdedora de `race()` a una llamada cancelable. | cancelación de corrida |
| **cancelación de corrida** | Cancelación global de la ejecución y de las operaciones ligadas a su señal. | cancelación de rama |
| **terminación de subproceso** | Detención efectiva de un proceso hijo iniciada al abortar `agent()`, `agents()` o `bash()`. | señal de cancelación |
| **descarte de diálogo** | Cierre de un `ask()` perdedor sin aceptar ni journalizar una respuesta. | terminación de subproceso |

## Resultado, evidencia y reanudación

| Término | Definición | Alias a evitar |
| --- | --- | --- |
| **resultado** | Valor retornado por el workflow y persistido en `result.json`. | artifact, salida de subagente |
| **entregable** | Contenido de trabajo todavía en memoria, como un borrador que un agente refina. | artifact de corrida |
| **artifact de corrida** | Archivo durable producido deliberadamente bajo el directorio de una corrida. | resultado, entregable, registro de corrida |
| **registro de eventos** | Cronología observable del ciclo de vida, normalmente persistida en `events.jsonl`. | journal de reanudación |
| **journal de reanudación** | Registro de llamadas completadas que permite replay por clave durante `resume`. | registro de eventos, log |
| **resume** | Nueva evaluación de la misma corrida que reutiliza llamadas journalizadas y puede repetir efectos no cacheados. | retry, restart, continuación desde el program counter |
| **lead** | Sospecha producida por una auditoría que todavía requiere comprobación. | bug, finding verificado |
| **finding verificado** | Hallazgo contrastado contra la fuente actual y su contrato observable. | lead, bug confirmado |
| **bug confirmado** | Finding reproducido mediante una ejecución fallida mínima o un test equivalente. | lead, finding plausible |
| **cobertura** | Parte del alcance inspeccionada por una auditoría, independiente de cuántos bugs se confirmaron. | exhaustividad, confirmación |

## Confianza y aislamiento

| Término | Definición | Alias a evitar |
| --- | --- | --- |
| **workspace autorizado** | Workspace que una persona revisó y autorizó explícitamente para ejecutar código. | workspace seguro, workspace confiable |
| **política de permisos** | Conjunto de operaciones que un runtime o agente puede invocar. | sandbox, decisión de confianza |
| **frontera de aislamiento OS** | Contención verificable de procesos, filesystem, credenciales y red frente a código hostil. | trust gate, `node:vm`, `Worker`, child process simple |

## Relaciones

- La **distribución Pandi** extiende **Pi**; los **hosts portables** son paquetes hermanos, no extensiones Pi.
- **`ultracode`** recibe una tarea y elige trabajo inline o un **workflow**; el **runtime** ejecuta el workflow.
- Lanzar un **workflow** crea una **corrida**; la corrida usa un **Workflow Worker** y puede crear **subagentes**.
- Un **patrón agéntico** puede tener un **scaffold** ejecutable; una adaptación mutable del scaffold es un **draft**.
- Una **corrida** tiene un **resultado**, un **registro de eventos** y un **journal de reanudación**, y puede producir
  cero o más **artifacts de corrida**.
- `resume` conserva la identidad de la **corrida**, pero vuelve a evaluar el programa y solo replayea llamadas
  journalizadas; los efectos no cacheados deben diseñarse como resume-safe.
- La **composition depth** es 1; para continuar después de una recomendación, el **orquestador** abre otra **corrida**.
  `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` limita esa **nested-run depth**, no la composición `workflow()`.
- `race()` emite una **señal de cancelación**; la **cancelación de rama** ocurre solo si el thunk la reenvía a
  `agent()`, `agents()`, `ask()`, `bash()` o `sleep()`.
- `agent()`, `agents()` y `bash()` solicitan la **terminación de subproceso**; `ask()` solicita el **descarte de
  diálogo** y `sleep()` rechaza su espera. `workflow()` y los helpers de filesystem/artifacts no cancelan efectos por
  rama.
- Autorizar un workspace habilita ejecución; no crea por sí solo una **frontera de aislamiento OS**.

## Ejemplo de diálogo

> **Dev:** “¿Agrego este patrón al catálogo como un scaffold?”
>
> **Experto:** “Solo si hay un workflow ejecutable y reusable. El patrón es la idea; el scaffold es su implementación de
> referencia. Una variante para esta tarea sería un draft.”
>
> **Dev:** “¿Entonces Ultracode ejecuta el scaffold y continúa exactamente donde quedó si hago `resume`?”
>
> **Experto:** “`ultracode` decide la ruta; el runtime crea o reanuda la corrida. `resume` vuelve a evaluar el workflow,
> replayea llamadas journalizadas y puede repetir appends u otros efectos no cacheados.”
>
> **Dev:** “¿Subir `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` deja que `router` despache otro subworkflow?”
>
> **Experto:** “No. La composition depth sigue en uno; esa variable solo limita nuevas corridas top-level. El
> orquestador debe abrir la siguiente corrida con la recomendación de `router`.”
>
> **Dev:** “¿`race()` detiene cualquier cosa que estuviera haciendo una rama perdedora?”
>
> **Experto:** “Solo si la rama reenvía la señal de cancelación a una primitiva cooperativa. Un `bash()` solicita
> terminar su subproceso y un `ask()` solicita descartar el diálogo; un write de filesystem no se revierte.”
>
> **Dev:** “¿El trust gate vuelve seguro ese código?”
>
> **Experto:** “No. Registra autorización humana; el aislamiento frente a código hostil exige una frontera OS.”

## Ambigüedades detectadas

- **Extensión / paquete / host:** `README.md:4` cuenta 28 extensiones, pero `package.json:88-121` registra 25 extensiones
  Pi y un tema; los tres paquetes `pandi-ultracode-*` son hosts externos.
- **Pandi:** `docs/setup.md:166-167` lo presenta como distribución, mientras `extensions/pandi/README.md:3-4` lo usa para
  la mascota y persona; en prosa técnica hace falta el calificador.
- **dynamic workflows / Ultracode:** `README.md:9` los presenta como nombres equivalentes, aunque
  `docs/handbooks/glosario-skills.md:20-29` separa producto, skill, tool y paquete.
- **patrón / scaffold:** `docs/handbooks/glosario-skills.md:39` los declara sinónimos, pero `README.md:3-4` distingue el
  patrón conceptual de su implementación ejecutable.
- **workflow / runtime / corrida:** `README.md:114` llama runtime al programa, mientras `docs/dynamic-workflows.md:131`
  reserva una corrida para la instancia con `runId`.
- **artifact:** `docs/dynamic-workflows.md:65,193` lo asocia a persistencia, pero `docs/scaffolds/self-refine.md:8,154`
  llama artifact a un borrador que nunca se escribe con `writeArtifact`.
- **journal:** `docs/dynamic-workflows.md:356` lo usa para replay de llamadas; `extensions/pandi-bg/README.md:43,56` llama
  journal al registro de ciclo de vida `events.jsonl`.
- **trust / aislamiento:** `docs/research/2026-07-11-ultracode-process-os-boundary.md:5-19` aclara que autorización,
  permisos y sandbox son propiedades distintas; la prosa pública todavía alterna `trusted` y “confiable”.
- **resume idempotente:** `README.md:139-140` y `docs/dynamic-workflows.md:335` lo prometen globalmente, aunque los efectos
  no cacheados se repiten y `appendArtifact` agrega bytes nuevamente.
- **contrato de autoría:** `extensions/pandi-dynamic-workflows/lib/transform.ts:46-51` declara canónico el script
  top-level y transicional el `export default`, pero `README.md:120`, `docs/dynamic-workflows.md:22` y los 25 scaffolds
  enseñan o usan la forma legacy.
- **phase:** `extensions/pandi-dynamic-workflows/primitives/phase.md:22-23` promete agrupar actividad y limpiar con
  `phase(null)`, pero `extensions/pandi-dynamic-workflows/runtime/worker-source.ts:289-293` solo emite markers no vacíos
  y `extensions/pandi-dynamic-workflows/runtime/agents.ts:45-60` crea otra fase por lote.
- **deep research:** `docs/handbooks/glosario-skills.md:55` llama atajo a `/deep-research`, pero
  `extensions/pandi-dynamic-workflows/surface/routing-commands.ts:38-44` solo genera un intent de routing genérico que
  puede elegir otra ruta.
