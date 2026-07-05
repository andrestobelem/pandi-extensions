# Glosario de prompts: qué queda en inglés

Los prompts internos del repo se escriben en español claro y preciso, pero hay
una lista de invariantes que **nunca se traducen**: todo lo que una máquina
parsea, matchea o cachea. Traducir uno de estos tokens rompe un verifier o un
test en silencio. Este glosario es la fuente canónica para cualquier
traducción — humana o por workflow.

- **Fecha:** 2026-07-04
- **Contrato padre:** [`pandi-prose-style`](../../.pi/skills/pandi-prose-style/SKILL.md)
  (fila "Subagent / workflow prompts" de la matriz de dosis)

## En 30 segundos

Si estás traduciendo un prompt y una palabra aparece en alguna tabla de abajo,
dejala byte-idéntica. Si no estás seguro de si algo es funcional, dejalo
byte-idéntico y marcalo para revisión — nunca adivines.

## 1. Nombres que el código resuelve

| Categoría | Ejemplos | Por qué se congela |
|---|---|---|
| Tools y globals | `goal_progress`, `submit_plan`, `agent()`, `agents(items,{settle:true})`, `writeArtifact`, `bash` | El harness los registra por nombre exacto |
| Campos JSON / schema keys | `successCriteria`, `assessment`, `nextStep`, `blocker`, `improvedTask`, `routingHints` | Los parsers leen la clave literal |
| Referencias de modelos | `anthropic/claude-haiku-4-5`, `sonnet`, `opus`, `effort: "high"` | El resolver matchea el id |
| Comandos y paths | `npm test`, `git ls-files`, `.pi/workflows/drafts/`, `dynamic_workflow action=start` | Se ejecutan tal cual |
| Tipos de Conventional Commits | `feat`, `fix`, `style(<scope>)`, `chore` | Convención externa del repo |

## 2. Tokens de contrato que un parser matchea

Estos son el **riesgo #1**: aparecen dentro de prosa de prompt pidiendo al
modelo que responda con un token exacto, y otro agente o función lo parsea.

| Token | Dónde se usa |
|---|---|
| `PASS` / `FAIL` | Verifier independiente de `/goal`; jueces de workflows |
| `NO_FINDINGS` | Contratos de evidencia en scaffolds (bug-hunt, audits) |
| `INSUFFICIENT_EVIDENCE` | Contratos de evidencia en scaffolds |
| `VERDICT: CONFIRMED` / `VERDICT: REJECTED` | Verificación adversarial (`adversarial-verify`, `bug-verify`) |
| Labels de estado (`ok`, `failed`, `running`) | `status.json` de runs; dashboards |

La regla práctica: si el prompt dice *"respond with exactly …"* (o
equivalente), lo que sigue queda en inglés aunque la oración se traduzca.

## 3. Estructura que sobrevive intacta a la traducción

No son palabras sino formas — se preservan al traducir:

- **Prefijos estables de prompt-cache**: framing fijo primero, contenido
  volátil al final. La traducción no reordena.
- **Fences de datos no confiables** (delimitadores de contenido externo).
- **Criterios de éxito repetidos al inicio Y al final** del prompt de
  síntesis/juez (mitiga lost-in-the-middle).
- **Contratos de tools** (qué recibe y qué devuelve cada tool).

## 4. Lo que sí se traduce

Todo lo demás: instrucciones, explicaciones de rol, criterios en prosa,
descripciones de tools (`description:` que lee el modelo), mensajes al
usuario. En español preciso, tono cero, sin 🐼 (los prompts no admiten
condimento — matriz de `pandi-prose-style`).

## Próximos pasos

Las waves 2 y 3 del plan de traducción usan este glosario como contrato de
entrada para cada worker y cada reviewer adversarial. Si encontrás un token
congelado que falta acá, agregalo en el mismo commit que la traducción que lo
descubrió.
