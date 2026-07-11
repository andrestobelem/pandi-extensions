---
name: github-project
description: >-
  Gestiona el tracking de issues de este repo en el GitHub Project v2
  "pandi" (usuario andrestobelem, project #4) con la gh CLI.
  Usar para crear stories/tasks/bugs, agregar items al board, mover el
  Status (Todo / In Progress / Done), setear Priority (P0-P3) o Size (S/M/L),
  armar epics con native sub-issues, gestionar milestones, cerrar trabajo
  desde commits, o responder "qué hay en el board / en progreso / falta / qué
  sigue por prioridad".
---

# GitHub Project «pandi»

Todo el trabajo de este repo se trackea como **issues del repo** ubicados en
el **GitHub Project v2 board "pandi"** (owner: usuario
`andrestobelem`, project `4`), manejado por completo desde la terminal con
`gh`. Este skill guarda los IDs ya verificados y las recetas de comandos
exactas para que ninguna sesión tenga que re-descubrirlos.

## En 30 segundos

Creá un issue etiquetado → agregalo al board → seteá Status/Priority con
`gh project item-edit`. Cerrá el trabajo con `Closes #N` en el commit.

```bash
gh issue create --title "..." --body "..." --label task
gh project item-add 4 --owner andrestobelem --url <issue-url>
```

## Convenciones (el contrato)

- **Los issues son la unidad de trabajo**, etiquetados por tipo: `story`
  (historia de usuario / epic), `task` (tarea concreta), `bug`, `tests`
  (trabajo de test suite), `tech-debt` (deuda / mejora de proceso). Combiná
  labels de tipo cuando sea honesto (p. ej. `task,tests`).
- **El Status del board** agrupa items: `Todo` → `In Progress` → `Done`.
  Mové un item a In Progress cuando realmente lo arrancás.
- **Cerrá desde el commit que termina el trabajo**: poné `Closes #N` en el
  body del mensaje de commit. Cuando el commit aterriza en la rama default,
  GitHub cierra el issue y el workflow nativo del project mueve su card a
  Done — sin edición manual del board.
- **Las stories linkean sus sub-tasks**: la story padre las lista en su body;
  el body de cada sub-task dice `Part of #N`. Mantené las sub-tasks chicas e
  independientemente cerrables.
- **El board del Project es la fuente de verdad** del estado de planificación:
  `Priority` (P0 más alta → P3) y `Size` (S/M/L) viven como campos del board,
  no solo en artifacts de corridas de grooming. El workflow `.pi/workflows/grooming.js`
  analiza y PROPONE comandos `item-edit` (propose-only); una persona los
  ejecuta. `.pi/workflows/sdlc.js` elige el siguiente issue como el item `Todo` de mayor
  Priority. Los artifacts de corrida son snapshots; el board es el estado
  actual.
- **Los epics son native sub-issues**, no solo texto en el body: linkeá los
  hijos a la story padre con la mutación GraphQL `addSubIssue` (recetas más
  abajo). GitHub calcula entonces `Sub-issues progress` automáticamente y el
  board puede agrupar por parent. Mantené la línea `Part of #N` en el body
  como cortesía legible para humanos; el link de sub-issue es la verdad que
  usa la máquina.

## Constantes verificadas (2026-07-04)

| Qué | Valor |
| --- | --- |
| Repo | `andrestobelem/pandi-extensions` |
| Project | número `4`, owner `andrestobelem` (user project, privado) |
| Project ID | `PVT_kwHOAEKsO84BcY5A` |
| Status field ID | `PVTSSF_lAHOAEKsO84BcY5AzhXCGf4` |
| Status option: Todo | `f75ad846` |
| Status option: In Progress | `47fc9ee4` |
| Status option: Done | `98236657` |
| Priority field ID | `PVTSSF_lAHOAEKsO84BcY5AzhXHPrs` |
| Priority options | P0 `5625c061` · P1 `431da638` · P2 `29bb2363` · P3 `01b46031` |
| Size field ID | `PVTSSF_lAHOAEKsO84BcY5AzhXHPrw` |
| Size options | S `cd9ee114` · M `b551b778` · L `254b9bf3` |

Si un `item-edit` falla con un field/option desconocido, re-derivá los IDs
(solo cambian si el field se recrea):

```bash
gh project field-list 4 --owner andrestobelem --format json \
  --jq '.fields[] | select(.name == "Status" or .name == "Priority" or .name == "Size")
        | {name, id, options: [.options[] | {name, id}]}'
```

## Recetas

Preflight una vez por sesión si algo falla con errores de auth: `gh auth status`
(el token debe tener el scope `project`; `gh auth refresh -s project` lo arregla).

### Crear un issue y ponerlo en el board

```bash
gh issue create --title "P5: cover pandi-effort parse errors" \
  --body "Part of #1. <what + why + evidence expected>" \
  --label task,tests
gh project item-add 4 --owner andrestobelem --url <issue-url-from-previous-output>
```

Un item recién agregado puede no tener Status todavía — seteá `Todo`
explícitamente con la receta de mover de abajo para que aparezca en la
columna correcta.

### Encontrar el id de item del board a partir del número de issue

`item-edit` necesita el PVTI item id, no el número de issue:

```bash
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.content.number == 2) | .id'
```

(El `--limit` por defecto es 30 — pasá siempre uno generoso; el board ya
tiene ~26 items.)

### Mover el Status de un item

```bash
gh project item-edit --id <PVTI-item-id> \
  --project-id PVT_kwHOAEKsO84BcY5A \
  --field-id PVTSSF_lAHOAEKsO84BcY5AzhXCGf4 \
  --single-select-option-id 47fc9ee4   # Todo f75ad846 · In Progress 47fc9ee4 · Done 98236657
```

### Setear Priority / Size en un item

Misma forma de `item-edit` que Status — un field por llamada (round-trip
verificado: set → query → `--clear`):

```bash
gh project item-edit --id <PVTI-item-id> \
  --project-id PVT_kwHOAEKsO84BcY5A \
  --field-id PVTSSF_lAHOAEKsO84BcY5AzhXHPrs \
  --single-select-option-id 431da638   # P0 5625c061 · P1 431da638 · P2 29bb2363 · P3 01b46031
# Size: --field-id PVTSSF_lAHOAEKsO84BcY5AzhXHPrw · S cd9ee114 · M b551b778 · L 254b9bf3
# Desetear un field: misma llamada con --clear en vez de --single-select-option-id
```

### Elegir el siguiente item de trabajo (Todo de mayor Priority)

En el JSON de `item-list` las claves de field están en minúscula (`priority`,
`size`); los items sin el field tienen `null`:

```bash
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '[.items[] | select(.status == "Todo" and .priority != null)]
        | sort_by(.priority) | .[0:5]
        | .[] | "\(.priority) #\(.content.number) \(.title)"'
```

(`sort_by(.priority)` funciona porque P0 < P1 < … ordena lexicográficamente.)

### Epics: native sub-issues

Las operaciones de sub-issue son solo GraphQL (no hay subcomando de `gh
project`/`gh issue`). `addSubIssue` acepta directamente la URL del hijo — sin
vueltas de node-ID (forma del input verificada contra el schema; mutaciones
ejercitadas on demand):

```bash
# Linkear un issue hijo a su story padre (epic)
PARENT_ID=$(gh api graphql -f query='{ repository(owner:"andrestobelem", name:"pandi-extensions")
  { issue(number:<PARENT>) { id } }}' --jq .data.repository.issue.id)
gh api graphql -f query="mutation { addSubIssue(input: { issueId: \"$PARENT_ID\",
  subIssueUrl: \"https://github.com/andrestobelem/pandi-extensions/issues/<CHILD>\" })
  { issue { number } subIssue { number } } }"

# Listar los hijos de un epic + progreso auto-calculado
gh api graphql -f query='{ repository(owner:"andrestobelem", name:"pandi-extensions")
  { issue(number:<PARENT>) { subIssuesSummary { total completed percentCompleted }
    subIssues(first: 50) { nodes { number title state } } } }}' --jq .data.repository.issue

# Desvincular / reordenar hijos: removeSubIssue · reprioritizeSubIssue (mismo estilo de input)
```

El board muestra esto vía los fields nativos `Parent issue` y `Sub-issues
progress` (agrupá una vista de tabla por Parent issue en la UI).

### Milestones (buckets de release)

```bash
gh api repos/andrestobelem/pandi-extensions/milestones -f title="v0.2 release" \
  -f description="<anchor story / scope>"          # crear
gh issue edit <N> --milestone "v0.2 release"       # asignar
gh issue list --milestone "v0.2 release"           # consultar
```

El field nativo `Milestone` del board los toma automáticamente.

### Terminar trabajo

Preferí cerrar desde el commit que aterriza (`Closes #N` en el body) antes
que cerrar a mano. Fallback manual: `gh issue close <N> --comment
"<evidence>"` — el workflow del project igual mueve la card a Done.

### Consultar el board

```bash
# Todo, campos agrupados aplanados: id | status | issue | labels | title
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | [.id, .status, "#\(.content.number)", (.labels | join(",")), .title] | @tsv'

# Solo lo que está en progreso (o Todo / Done)
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.status == "In Progress") | "#\(.content.number) \(.title)"'
```

Las consultas del lado del issue quedan en el repo: `gh issue list --label
task --state open`.

## Cosas a tener en cuenta

- Los subcomandos `gh project` necesitan `--owner andrestobelem` siempre —
  sin eso, gh adivina a partir del repo y no encuentra user projects.
- JSON de `item-list`: `status` es un string plano (`"Todo"` / `"In
  Progress"` / `"Done"`), el número de issue es `content.number`, labels es
  un array de strings.
- El project es **privado**: linkeá cards por número de issue en texto, no
  esperes que viewers externos resuelvan URLs del project.
- Un `item-edit` setea UN field; mover Status y editar otros fields son
  llamadas separadas.
- `gh project field-create` solo soporta `TEXT|SINGLE_SELECT|DATE|NUMBER` —
  **los Iteration fields no se pueden crear desde la CLI** (solo UI);
  leerlos/setearlos vía GraphQL funciona una vez creados.
- Las mutaciones de sub-issue (`addSubIssue` / `removeSubIssue` /
  `reprioritizeSubIssue`) existen solo en GraphQL; el parent debe pasarse
  como node ID (`issueId`), el child puede ser un `subIssueUrl` plano.
- Los single-select fields nuevos creados vía CLI reciben option IDs
  auto-generados — registralos acá enseguida (tabla de arriba) para que
  ninguna sesión los tenga que re-derivar. 🐼
