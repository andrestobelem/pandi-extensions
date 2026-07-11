---
name: github-project
description:
  Gestioná con `gh` los issues y el Project v2 `pandi` al crear o cerrar trabajo, mover items y campos, administrar
  epics o milestones, o consultar progreso y prioridades.
---

# GitHub Project «pandi»

Todo el trabajo de este repo se trackea como **issues del repo** ubicados en el **GitHub Project v2 board "pandi"**
(owner: usuario `andrestobelem`, project `4`), manejado por completo desde la terminal con `gh`. Este skill guarda los
IDs ya verificados y las recetas de comandos exactas para que ninguna sesión tenga que re-descubrirlos.

## En 30 segundos

Creá un issue etiquetado → agregalo al board → seteá Status/Priority con `gh project item-edit`. Cerrá el trabajo con
`Closes #N` en el commit.

```bash
gh issue create --title "..." --body "..." --label task
gh project item-add 4 --owner andrestobelem --url <issue-url>
```

## Convenciones (el contrato)

- **Los issues son la unidad de trabajo**, etiquetados por tipo: `story` (historia de usuario / epic), `task` (tarea
  concreta), `bug`, `tests` (trabajo de test suite), `tech-debt` (deuda / mejora de proceso). Combiná labels de tipo
  cuando sea honesto (p. ej. `task,tests`).
- **El Status del board** agrupa items: `Todo` → `In Progress` → `Done`. Mové un item a In Progress cuando realmente lo
  arrancás.
- **Cerrá desde el commit que termina el trabajo**: poné `Closes #N` en el body del mensaje de commit. Cuando el commit
  aterriza en la rama default, GitHub cierra el issue y el workflow nativo del project mueve su card a Done — sin
  edición manual del board.
- **Las stories linkean sus sub-tasks**: la story padre las lista en su body; el body de cada sub-task dice
  `Part of #N`. Mantené las sub-tasks chicas e independientemente cerrables.
- **El board del Project es la fuente de verdad** del estado de planificación: `Priority` (P0 más alta → P3) y `Size`
  (S/M/L) viven como campos del board, no solo en artifacts de corridas de grooming. El workflow
  `.pi/workflows/grooming.js` analiza y PROPONE comandos `item-edit` (propose-only); una persona los ejecuta.
  `.pi/workflows/sdlc.js` elige el siguiente issue como el item `Todo` de mayor Priority. Los artifacts de corrida son
  snapshots; el board es el estado actual.
- **Los epics son native sub-issues**, no solo texto en el body: linkeá los hijos a la story padre con la mutación
  GraphQL `addSubIssue` (recetas más abajo). GitHub calcula entonces `Sub-issues progress` automáticamente y el board
  puede agrupar por parent. Mantené la línea `Part of #N` en el body como cortesía legible para humanos; el link de
  sub-issue es la verdad que usa la máquina. Para crear, listar, desvincular o reordenar hijos, cargá
  [`references/advanced-operations.md`](references/advanced-operations.md#epics-con-sub-issues-nativos).

## Constantes verificadas (2026-07-04)

| Qué                        | Valor                                                         |
| -------------------------- | ------------------------------------------------------------- |
| Repo                       | `andrestobelem/pandi-extensions`                              |
| Project                    | número `4`, owner `andrestobelem` (user project, privado)     |
| Project ID                 | `PVT_kwHOAEKsO84BcY5A`                                        |
| Status field ID            | `PVTSSF_lAHOAEKsO84BcY5AzhXCGf4`                              |
| Status option: Todo        | `f75ad846`                                                    |
| Status option: In Progress | `47fc9ee4`                                                    |
| Status option: Done        | `98236657`                                                    |
| Priority field ID          | `PVTSSF_lAHOAEKsO84BcY5AzhXHPrs`                              |
| Priority options           | P0 `5625c061` · P1 `431da638` · P2 `29bb2363` · P3 `01b46031` |
| Size field ID              | `PVTSSF_lAHOAEKsO84BcY5AzhXHPrw`                              |
| Size options               | S `cd9ee114` · M `b551b778` · L `254b9bf3`                    |

Si un `item-edit` falla con un field/option desconocido, re-derivá los IDs (solo cambian si el field se recrea):

```bash
gh project field-list 4 --owner andrestobelem --format json \
  --jq '.fields[] | select(.name == "Status" or .name == "Priority" or .name == "Size")
        | {name, id, options: [.options[] | {name, id}]}'
```

## Recetas

Preflight una vez por sesión si algo falla con errores de auth: `gh auth status` (el token debe tener el scope
`project`; `gh auth refresh -s project` lo arregla).

### Crear un issue y ponerlo en el board

```bash
gh issue create --title "P5: cover pandi-effort parse errors" \
  --body "Part of #1. <what + why + evidence expected>" \
  --label task,tests
gh project item-add 4 --owner andrestobelem --url <issue-url-from-previous-output>
```

Un item recién agregado puede no tener Status todavía — seteá `Todo` explícitamente con la receta de mover de abajo para
que aparezca en la columna correcta.

### Encontrar el id de item del board a partir del número de issue

`item-edit` necesita el PVTI item id, no el número de issue:

```bash
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.content.number == 2) | .id'
```

(El `--limit` por defecto es 30 y puede truncar el board; pasá siempre uno generoso.)

### Mover el Status de un item

```bash
gh project item-edit --id <PVTI-item-id> \
  --project-id PVT_kwHOAEKsO84BcY5A \
  --field-id PVTSSF_lAHOAEKsO84BcY5AzhXCGf4 \
  --single-select-option-id 47fc9ee4   # Todo f75ad846 · In Progress 47fc9ee4 · Done 98236657
```

### Setear Priority / Size en un item

Misma forma de `item-edit` que Status — un field por llamada (round-trip verificado: set → query → `--clear`):

```bash
gh project item-edit --id <PVTI-item-id> \
  --project-id PVT_kwHOAEKsO84BcY5A \
  --field-id PVTSSF_lAHOAEKsO84BcY5AzhXHPrs \
  --single-select-option-id 431da638   # P0 5625c061 · P1 431da638 · P2 29bb2363 · P3 01b46031
# Size: --field-id PVTSSF_lAHOAEKsO84BcY5AzhXHPrw · S cd9ee114 · M b551b778 · L 254b9bf3
# Desetear un field: misma llamada con --clear en vez de --single-select-option-id
```

### Elegir el siguiente item de trabajo (Todo de mayor Priority)

En el JSON de `item-list` las claves de field están en minúscula (`priority`, `size`); los items sin el field tienen
`null`:

```bash
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '[.items[] | select(.status == "Todo" and .priority != null)]
        | sort_by(.priority) | .[0:5]
        | .[] | "\(.priority) #\(.content.number) \(.title)"'
```

(`sort_by(.priority)` funciona porque P0 < P1 < … ordena lexicográficamente.)

### Terminar trabajo

Preferí cerrar desde el commit que aterriza (`Closes #N` en el body) antes que cerrar a mano. Fallback manual:
`gh issue close <N> --comment "<evidence>"` — el workflow del project igual mueve la card a Done.

### Consultar el board

```bash
# Todo, campos agrupados aplanados: id | status | issue | labels | title
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | [.id, .status, "#\(.content.number)", (.labels | join(",")), .title] | @tsv'

# Solo lo que está en progreso (o Todo / Done)
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.status == "In Progress") | "#\(.content.number) \(.title)"'
```

Las consultas del lado del issue quedan en el repo: `gh issue list --label task --state open`.

## Operaciones avanzadas

- Para crear, consultar o reordenar epics con sub-issues nativos, cargá
  [`references/advanced-operations.md`](references/advanced-operations.md#epics-con-sub-issues-nativos).
- Para crear o asignar milestones de release, cargá
  [`references/advanced-operations.md`](references/advanced-operations.md#milestones-como-buckets-de-release).
- Ante errores de owner, campos, visibilidad o limitaciones de CLI/GraphQL, consultá
  [`references/advanced-operations.md`](references/advanced-operations.md#restricciones-y-gotchas).
