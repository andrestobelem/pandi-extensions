# Operaciones avanzadas del GitHub Project `pandi`

Cargá esta referencia sólo para gestionar epics nativos, milestones o límites operativos de GitHub Project v2.

## Epics con sub-issues nativos

Las operaciones de sub-issue son solo GraphQL; no hay subcomando de `gh project` ni `gh issue`. `addSubIssue` acepta
directamente la URL del hijo, sin convertirla a node ID. La forma del input está verificada contra el schema.

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

El board muestra la relación mediante los fields nativos `Parent issue` y `Sub-issues progress`. En la UI, agrupá una
vista de tabla por parent cuando necesites observar el progreso del epic.

**Cierre:** cada hijo aparece bajo la story correcta y `subIssuesSummary` refleja el total y progreso esperados.

## Milestones como buckets de release

```bash
gh api repos/andrestobelem/pandi-extensions/milestones -f title="v0.2 release" \
  -f description="<anchor story / scope>"          # crear
gh issue edit <N> --milestone "v0.2 release"       # asignar
gh issue list --milestone "v0.2 release"           # consultar
```

El field nativo `Milestone` del board refleja estas asignaciones automáticamente.

**Cierre:** el milestone existe, los issues esperados lo tienen asignado y la consulta devuelve el bucket correcto.

## Restricciones y gotchas

- Los subcomandos `gh project` necesitan siempre `--owner andrestobelem`; sin eso, `gh` adivina a partir del repo y no
  encuentra user projects.
- En el JSON de `item-list`, `status` es un string plano (`"Todo"`, `"In Progress"` o `"Done"`), el número de issue es
  `content.number` y `labels` es un array de strings.
- El project es privado. En texto para audiencia externa, referenciá cards por número de issue en lugar de depender de
  URLs del project.
- Cada `item-edit` setea un solo field; mover Status y editar otros fields requiere llamadas separadas.
- `gh project field-create` soporta `TEXT`, `SINGLE_SELECT`, `DATE` y `NUMBER`. Los Iteration fields se crean desde la
  UI; una vez creados, GraphQL permite leerlos y setearlos.
- Las mutaciones `addSubIssue`, `removeSubIssue` y `reprioritizeSubIssue` existen sólo en GraphQL. El parent usa node ID
  (`issueId`) y el child puede usar una URL plana (`subIssueUrl`).
- Los single-select fields nuevos reciben option IDs auto-generados. Registralos en la tabla de constantes de `SKILL.md`
  apenas se creen para evitar re-derivarlos.
