---
name: didactic-docs-style
description:
  Aplicá el contrato didáctico del repo al escribir, editar, revisar o generar guías de dynamic workflows, páginas de
  scaffolds, referencias de primitives y READMEs, a mano o mediante `didactic-docs` / `scaffold-docs-html`. Exigí
  apertura en 30 segundos, disclosure progresivo, tablas o Mermaid para decisiones, ejemplos mínimos ejecutables y
  exactitud intacta.
---

# Contrato de estilo para docs didácticas

Objetivo: hacer cada doc MÁS CLARO y MÁS DIDÁCTICO sin perder ni un bit de exactitud técnica; claridad y corrección
viajan juntas, nunca se intercambian. Este contrato es la fuente única del estándar de documentación didáctica del repo;
los workflows que editan o generan docs deben cargarlo y pasarlo a cada agente editor/reviewer.

## En 30 segundos

Contrato único para que cada doc abra claro en media minuta, revele progresivamente y no sacrifique exactitud. Para
tono/🐼 en prosa, deferí a `pandi-prose-style`.

**Shape mínimo de apertura:** 2–3 frases → snippet ejecutable 3–8 líneas → referencia exhaustiva.

## Las 8 reglas

1. **Apertura en 30 segundos.** Empezá con 2-3 frases en lenguaje claro: qué es, qué problema resuelve y cuándo usarlo.
   DESPUÉS poné un ejemplo mínimo ejecutable, ANTES de cualquier referencia exhaustiva.
2. **Disclosure progresivo.** Orden: quickstart → conceptos → referencia → casos avanzados/bordes. Nunca abras con una
   pared de detalles de API.
3. **Ayudas para decidir.** Cuando la persona lectora deba elegir entre alternativas (agents vs pipeline vs parallel vs
   race; run vs start; cuándo orquestar o no), agregá una tabla chica de decisión o un flowchart Mermaid. Preferí una
   buena tabla a tres párrafos.
4. **Ejemplos mínimos.** Cada primitive/comando lleva un snippet de 3-8 líneas que realmente podría correr. Verificá
   firmas y comportamiento contra el código fuente de la extensión; nunca inventes.
5. **La exactitud es intocable.** Cada afirmación debe poder chequearse en el código. Si dudás, leé la implementación.
   Conservá todos los hechos existentes; podés reordenar, reescribir, ejemplificar e ilustrar, no debilitar ni eliminar.
6. **Español por defecto para docs públicas.** La documentación pública del repo se escribe en español por defecto.
   Mantené inglés solo para nombres de API, comandos, flags, package names, literales, títulos externos y términos
   técnicos canónicos cuando traducirlos reduzca claridad.
7. **Mantenelo ajustado.** Didáctico ≠ más largo. Cortá redundancia; los docs de primitives deben ser breves (viajan en
   el paquete npm): objetivo ≤ ~65 líneas cada uno.
8. **Higiene Markdown.** GFM válido, jerarquía sensata de headings, fences de código con language tags y diagramas
   Mermaid en bloques con el tag `mermaid`. Debe pasar los defaults de markdownlint: sin trailing spaces, un solo H1 y
   líneas en blanco alrededor de headings, listas y fences. Ajustá la prosa fuente a un máximo de 120 caracteres por
   línea; `MD013` exceptúa tablas y bloques de código. Pasá ejemplos indivisibles a un fence cuando envolverlos reduzca
   legibilidad o exactitud.

## Páginas de scaffolds: shape requerido

Cada página `docs/scaffolds/<key>.md` además sigue este orden de secciones (ver cualquier página existente, por ejemplo
`docs/scaffolds/map-reduce.md`):

`# <key>` → blurb quote → **En 30 segundos** → **Cómo lanzarlo** (comandos `/workflow` ejecutables) → **Diagrama**
(Mermaid derivado del código real) → **Qué hace** → **Cuándo usarlo** → **Cómo funciona** → **Input y output** →
**Fases**.

## Cómo se aplica

- Generación: `.pi/workflows/scaffold-docs-html.js` escribe las fuentes Markdown bajo `docs/scaffolds/` y corre
  `npm run sync:docs:html` (el mirror `docs/html/` es GENERADO; nunca lo edites a mano).
- Mejora: `.pi/workflows/didactic-docs.js` edita docs en paralelo bajo este contrato y luego corre un panel de review
  adversarial (exactitud + didáctica) → fixes → verificación (markdownlint + reconversión HTML).
- Ambos workflows deben leer este archivo y `pandi-prose-style` como contratos de estilo, no copias ad hoc.
