# @pandi-coding-agent/pandi-plan

`/plan` agrega a Pi un modo plan de solo lectura, estilo Claude: investiga y redacta un plan mientras toda tool mutante queda bloqueada de forma dura, y solo implementa después de tu aprobación explícita. Úsalo antes de un cambio riesgoso, ambiguo o de varios pasos, así podés revisar el enfoque antes de tocar archivos.

```text
/plan Agregar login OAuth al API -- inspeccioná el flujo de auth actual y luego proponé los cambios
```

Pi investiga en solo lectura, llama a `submit_plan` con el plan completo y lo muestra en un overlay Markdown con scroll. Presioná `y`/`Enter` para aprobar e implementar, o `n`/`Esc`/`q` para rechazar y pedir una revisión. Si activás `auto-submit`, 60 segundos sin elección aprueban el plan.

## Qué te da

- Un comando `/plan` que arma un gate de solo lectura para una tarea hasta que apruebes el plan enviado.
- Una tool de modelo `enter_plan_mode`, para que Pi pueda entrar solo en modo plan antes de un cambio no trivial o riesgoso; la aprobación igual queda en tus manos.
- Una tool de modelo `submit_plan` con un overlay de aprobación renderizado en Markdown y con scroll; cerrar equivale a rechazar, nunca a aprobar implícitamente salvo que habilites `auto-submit`.
- Un dashboard de seguimiento y una línea de estado por sesión.
- Flags de postura combinables tipo `ultracode` para indicarle al planificador o implementador que use dynamic workflows.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-plan
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-plan              # global (tu usuario)
pi install -l ./extensions/pandi-plan           # local al proyecto
pi --no-extensions -e ./extensions/pandi-plan   # prueba puntual, sin cargar nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/plan [--ultracode\|--uc] [--ultracode-steps\|--uc-steps] [--auto-submit] <task>` | Entra en modo plan de solo lectura para una tarea. |
| `/plan status` | Inspecciona el plan activo: estado, flags de postura y conteos. |
| `/plan dashboard` | Abre el dashboard de seguimiento: totales de la sesión, plan activo e historial de todos los planes de la sesión (con scroll en TUI; Markdown impreso en otros modos). |
| `/plan ultracode on\|off\|status` | Valor por defecto de sesión para la postura `ultracode`; un `/plan <task>` sin flags la hereda. |
| `/plan steps-ultracode on\|off\|status` | Valor por defecto de sesión para la postura `ultracode-steps`. |
| `/plan auto-submit on\|off\|status` | Valor por defecto de sesión para autoaprobar tras 60 segundos sin elección. |
| `/plan exit\|cancel` | Sale del modo plan sin implementar. |
| `enter_plan_mode` | Tool de modelo: Pi entra por sí mismo en modo plan antes de un cambio riesgoso o de varios pasos. Acepta booleanos `nonInteractive`, `ultracode` y `ultracodeSteps`. |
| `submit_plan` | Tool de modelo: envía el artefacto del plan para aprobación humana explícita. |

## `/plan` vs `enter_plan_mode`

Ambos arman el mismo gate de solo lectura y terminan en `submit_plan`; la diferencia es quién inicia la planificación y dónde puede correr.

| | `/plan <task>` | `enter_plan_mode` (tool de modelo) |
| --- | --- | --- |
| Quién lo invoca | Vos, explícitamente | Pi, por iniciativa propia para trabajo riesgoso o de varios pasos |
| Modo de sesión | Solo TUI/RPC (necesita un humano que apruebe) | TUI/RPC, o `print`/`json` con `nonInteractive: true` (solo plan, sin aprobación) |
| Cómo llega el prompt | Se inyecta como nuevo user message | Vuelve como resultado de la propia tool, en el mismo turno |

## Cómo funciona

- Mientras el modo plan está activo, las tools mutantes quedan bloqueadas hasta que apruebes el plan enviado.
- El modelo puede *entrar* en modo plan, pero nunca puede *aprobar* un plan: en una sesión interactiva la aprobación siempre es una confirmación humana explícita.
- El overlay de aprobación es estilo mdview: `↑/↓ j/k` desplazan, `PgUp/PgDn` paginan; `y`/`Enter` aprueban, `n`/`Esc`/`q` rechazan. Cuando `auto-submit` está habilitado, el overlay muestra una cuenta regresiva y aprueba después de 60 segundos sin elección. Si no se puede mostrar un componente personalizado, degrada a un diálogo `confirm` simple con el mismo comportamiento de timeout.
- El gate de solo lectura (ver `gate.ts`) solo permite investigar: `read`, `grep`, `find`, `ls` y shell de solo lectura (`git ls-files`, `git status`, `cat`, `head`, `sed -n`, …). Bloquea `write`, `edit` y shell mutante (`rm`, `mv`, `git commit/add/push/reset`, redirecciones `>`/`>>`, instalaciones de paquetes, …).

## Límites y notas de seguridad

- La allowlist de bash es best-effort y prefiere bloquear ante la duda.
- En modo no interactivo (`plan-only`) el gate **nunca se levanta**: no hay aprobación ni implementación durante toda la sesión (ver Detalles).
- Sin la flag no interactiva, las sesiones `print`/`json` rechazan entrar en modo plan (se preserva la back-compat existente).
- `dynamic_workflow` queda gateado por `action` mientras planificás: se permiten acciones de solo lectura (`list`, `scaffold`, `read`, `graph`, `runs`, `view`); `run`, `start`, `resume`, `write`, `cancel`, `delete`, `report` (escribe un reporte HTML en disco) y las acciones faltantes o desconocidas se bloquean, porque pueden escribir archivos o lanzar subagentes mutantes cuyos tool calls saltean el gate.
- Evitá la recursión: un subagente solo-plan debería *nombrar* los workflows a correr; el **orquestador** los ejecuta después de la aprobación. No dejes que un subagente lance subagentes que a su vez lancen workflows.

## Detalles

### Flags de postura

Cuatro controles ortogonales ajustan el modo plan. `Ultracode`, `Ultracode steps` y `Auto-submit` resuelven con precedencia **param explícito/flag de comando → toggle de sesión → setting de entorno → valor por defecto (off)**; `Non-interactive` no tiene toggle de sesión, así que resuelve **param explícito → setting de entorno → valor por defecto (off)**:

| Flag | Param de `enter_plan_mode` | Flag de `/plan` | Setting de entorno | Efecto |
| --- | --- | --- | --- | --- |
| Non-interactive | `nonInteractive` | (solo tool/env) | `PI_PLAN_NONINTERACTIVE` | Solo plan: entra incluso en `print`/`json` (p. ej. un subagente de workflow). |
| Ultracode | `ultracode` | `--ultracode` | `PI_PLAN_ULTRACODE` | Le indica al planificador que investigue/diseñe el plan **con dynamic workflows**. |
| Ultracode steps | `ultracodeSteps` | `--ultracode-steps` | `PI_PLAN_ULTRACODE_STEPS` | Le indica al planificador/implementador que ejecute los **pasos del plan vía dynamic workflows**. |
| Auto-submit | (solo comando/env humano) | `--auto-submit` | `PI_PLAN_AUTO_SUBMIT` | Autoaprueba el plan enviado después de 60 segundos sin elección. |

El comando `/plan` es solo interactivo, así que no acepta `--non-interactive`; la entrada no interactiva es trabajo de la tool `enter_plan_mode`. Los toggles de sesión (`/plan ultracode`, `/plan steps-ultracode`, `/plan auto-submit`) fijan un valor por defecto en memoria para el resto de la sesión y se resetean en cada frontera de sesión.

### Modo no interactivo (`plan-only`)

En sesiones `print`/`json` no hay humano que apruebe, así que el modo plan corre como solo-plan: arma el gate de solo lectura, el modelo investiga y llama a `submit_plan`, y el plan **se devuelve como entregable**. Eso es lo que permite que un subagente de dynamic workflow produzca un plan:

```js
// dentro de un workflow: recuperá un plan desde un subagente sandboxeado y de solo lectura
const { output } = await ctx.agent("Planificá la migración y luego devolvé el plan completo.", {
  includeExtensions: true, // cargá pandi-plan en el subagente
  env: { PI_PLAN_NONINTERACTIVE: "1", PI_PLAN_ULTRACODE_STEPS: "1" },
  // NOTA: NO le des al planificador poder de `dynamic_workflow` run/start. El plan debe NOMBRAR
  // los workflows; el ORQUESTADOR los ejecuta. Así la composición se mantiene no recursiva.
  tools: ["read", "grep", "find", "ls", "enter_plan_mode", "submit_plan"],
});
```

El modo solo-plan mantiene el gate armado durante toda la sesión, así que incluso si un subagente tuviera `dynamic_workflow` no podría correr workflows `run`/`start` mientras planifica: solo las acciones de catálogo de solo lectura.

### Dynamic workflows dentro de un plan

Un plan **puede proponer correr dynamic workflows** (p. ej. `action=run`/`start`) como pasos de implementación para trabajo amplio, paralelo o de alta confianza: auditorías grandes, migraciones, barridos exhaustivos, verificación independiente o investigación profunda. Esos pasos se ejecutan solo **después** de que apruebes el plan y el gate se levante. El prompt de planificación se lo explica al modelo, así que sabe que esa opción existe mientras diseña la implementación.

## Relacionado

Si querés el bundle completo de extensiones y skills, instalá la raíz del repositorio.
