# Issue tracker: GitHub

Issues y tareas de este repo viven en GitHub Issues de `andrestobelem/pandi-extensions`. Usá `gh` para operarlos y
agregalos al GitHub Project v2 `pandi` cuando corresponda.

## Convenciones

- **Crear:** `gh issue create --title "..." --body "..."`; usá un heredoc para bodies multilínea.
- **Leer:** `gh issue view <number> --comments`; incluí labels y el contexto del issue antes de actuar.
- **Listar:** `gh issue list --state open` con los filtros de label o estado que demande la tarea.
- **Comentar:** `gh issue comment <number> --body "..."`.
- **Etiquetar:** `gh issue edit <number> --add-label "..."` o `--remove-label "..."`.
- **Cerrar:** incluí `Closes #<number>` en el commit que completa el trabajo, o usá `gh issue close` cuando no haya commit.

El remote GitHub se infiere desde el checkout; `gh` lo resuelve automáticamente.

## Pull requests como superficie de triage

**PRs como superficie de solicitudes: no.** Los flujos de triage procesan GitHub Issues, no PRs externos.

## Cuando un skill nombra el issue tracker

- **Publicar en el issue tracker:** crear un GitHub Issue.
- **Traer el ticket relevante:** ejecutar `gh issue view <number> --comments`.
- **Mover trabajo en el board:** seguir las recetas verificadas de `.pi/skills/github-project/SKILL.md`.
