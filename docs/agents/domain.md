# Domain docs

Los skills de ingeniería consumen la documentación de dominio de este repo con un layout **single-context**.

## Antes de explorar

Leé, cuando existan y sean pertinentes:

- `CONTEXT.md` en la raíz.
- `docs/adr/` para decisiones que afecten el área de trabajo.

Si todavía no existen, seguí sin reportar su ausencia. `domain-modeling` los crea de forma perezosa al resolver un
concepto o una decisión que realmente necesite persistencia.

## Layout esperado

```text
/
├── CONTEXT.md
├── docs/adr/
│   └── 0001-decision.md
└── extensions/
```

## Uso

Usá la terminología definida en `CONTEXT.md` en issues, propuestas, hipótesis y tests. Si una decisión propuesta
contradice un ADR existente, señalalo explícitamente en vez de reemplazarlo de forma silenciosa.
