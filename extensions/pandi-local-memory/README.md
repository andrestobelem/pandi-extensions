# @pandi-coding-agent/pandi-local-memory

Dale a Pi una carpeta de memoria local del proyecto (`.pi/memory/`) que sobreviva entre sesiones. Sin ella, cada sesión
nueva arranca desde cero y vuelve a descubrir tus convenciones y decisiones previas; con ella, un índice `MEMORY.md`
capado se inyecta en el system prompt en cada turno, y Pi puede persistir notas durables por su cuenta con la tool
`remember`. Usala cuando quieras que preferencias, convenciones y decisiones estables queden guardadas sin editar
archivos a mano.

## Ejemplo

Pi llama a `remember` por su cuenta cuando vale la pena guardar algo:

```json
{ "note": "Este repo usa pnpm, no npm." }
```

Eso agrega una viñeta fechada dentro de un bloque gestionado de `.pi/memory/MEMORY.md`:

```md
<!-- pi:remember:begin -->

## Memoria del agente (gestionada automáticamente por la tool remember)

- 2026-07-04: Este repo usa pnpm, no npm.
<!-- pi:remember:end -->
```

En la próxima sesión, ese archivo se inyecta automáticamente en el system prompt — sin pasos extra.

## Qué incluye

- `.pi/memory/MEMORY.md` — el índice, inyectado automáticamente en cada turno (capado a las primeras 200 líneas o 25 KB,
  lo que llegue primero).
- `.pi/memory/<topic>.md` — archivos de topic, nunca inyectados; el bloque inyectado lista sus rutas para que Pi los lea
  bajo demanda.
- `remember` model tool — le permite a Pi guardar preferencias estables, convenciones del proyecto y decisiones clave
  para sesiones futuras.
- Compatibilidad hacia atrás — cae al legado `.pi/MEMORY.md` cuando el índice de la carpeta no existe.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-local-memory
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-local-memory          # global (tu usuario)
pi install -l ./extensions/pandi-local-memory       # local al proyecto
pi --no-extensions -e ./extensions/pandi-local-memory   # prueba puntual, sin cargar nada más
```

## Uso

| Superficie               | Qué hace                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `remember` (sin `topic`) | Tool del modelo: agrega una nota durable al índice inyectado `.pi/memory/MEMORY.md`.                                                      |
| `remember` con `topic`   | Tool del modelo: agrega la nota a `.pi/memory/<topic>.md` (el topic se convierte en slug, así que el path traversal es imposible).        |
| Inyección por turno      | Inyecta el índice (o el legado `.pi/MEMORY.md`) como un bloque etiquetado en el system prompt y lista las rutas de los archivos de topic. |

## Cómo funciona

- `remember` agrega solo dentro de un bloque gestionado (`<!-- pi:remember:begin -->` … `<!-- pi:remember:end -->`), así
  que las notas curadas por humanos nunca se tocan.
- Volver a guardar la misma nota es un no-op, y los errores de lectura/escritura fallan en forma segura: nada se pisa si
  el destino no pudo leerse.
- La primera escritura del índice se inicializa desde cualquier `.pi/MEMORY.md` legado sin borrarlo; la nota vuelve al
  contexto en la próxima sesión gracias a la inyección de arriba.

## Notas de limitaciones y seguridad

- **Solo proyectos confiables.** Cuando se carga (por ejemplo, de forma global), la extensión auto-inyecta
  `.pi/memory/MEMORY.md` (o el legado `.pi/MEMORY.md`) del proyecto que abras — sin prompt, allowlist ni chequeo de
  procedencia. Un repositorio que no controlás podría traer un índice committeado para influir en el asistente.
- Los archivos de topic tienen menor riesgo: se listan, pero nunca se inyectan automáticamente.
- Los tags literales `</local_memory>` en el índice se escapan, y el índice tiene un límite de longitud, así que el
  cuerpo inyectado no puede salir estructuralmente de su bloque. Esto no cubre todo el tag, sin embargo: el atributo
  `path="${shownPath}"` del tag de apertura `<local_memory path="...">` se construye desde `ctx.cwd` (vía
  `indexPathOf`/`legacyPathOf`) y no se escapa (`extensions/pandi-local-memory/index.ts:157`), así que un path de
  proyecto malicioso podría romper estructuralmente el valor del atributo.
- **Lado de escritura (anti-inyección).** `remember` escribe en un canal que se reinyecta en futuros system prompts como
  contexto confiable — un límite de autoridad. El asistente debería persistir solo hechos que haya verificado por su
  cuenta, con sus propias palabras, y nunca copiar a la memoria contenido no confiable recuperado de tools/web o pegado
  por el usuario (ni instrucciones embebidas en ese contenido). Los delimitadores no son un límite de seguridad
  semántico; la defensa real es no ingerir contenido no confiable desde el inicio.
- Usalo solo para notas locales del proyecto que sean confiables.

## Relacionados

Para obtener el paquete completo de extensiones y skills, instalá la raíz del repositorio.
