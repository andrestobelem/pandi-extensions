# @pandi-coding-agent/pandi-rename

Dale a la sesión actual un nombre corto y fácil de leer en lugar de un UUID, para que `/resume`, `pi -r` y la pista de
salida sean más simples de escanear. Si pasás un nombre, se usa tal cual; si llamás `/rename` sin argumento, resume tu
actividad más reciente y lo convierte en uno — un `/rename` al estilo Claude para Pi.

```text
/rename Refactor auth module   ->  refactor-auth-module
/rename "Hello World!"         ->  hello-world
/rename Café                   ->  cafe
/rename                        ->  (el LLM resume la actividad reciente, p. ej. debug-flaky-test)
```

## `/rename` frente al `/name` nativo de Pi

| Qué querés hacer                       | Usá                                                    |
| -------------------------------------- | ------------------------------------------------------ |
| Fijar un nombre exacto de sesión       | `/rename <name>` o `/name <name>` (mismo efecto)       |
| Autogenerar un nombre desde el trabajo | `/rename` sin argumento — `/name` no tiene equivalente |

`/rename` es un **superconjunto** funcional de `/name`: apunta al mismo destino (`pi.setSessionName`) y suma la ruta de
autogeneración. Coexiste con `/name` y nunca lo sobrescribe.

Cada nombre se guarda como un **slug**: ASCII en minúscula, separado por guiones, sin diacríticos, con un máximo de 4
palabras / 60 caracteres. El nombre actual se muestra como una pastilla de color invertido en el borde superior del
editor y como una pista `Nombre de sesión:` al salir.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-rename
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-rename             # global (tu usuario)
pi install -l ./extensions/pandi-rename          # local al proyecto
pi --no-extensions -e ./extensions/pandi-rename  # prueba puntual, sin cargar nada más
```

## Comandos

| Comando          | Qué hace                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `/rename <name>` | Convierte `<name>` en slug y lo fija como nombre visible de la sesión (instantáneo, sin LLM). |
| `/rename`        | Resume tu actividad más reciente con el LLM en un slug y lo aplica directo, sin diálogo.      |

## Cómo funciona

- **Autonombre:** un subproceso `pi -p` de una sola pasada resume la parte más reciente de la conversación en un título
  corto, y luego se lo convierte en slug. Volver a ejecutar `/rename` a medida que avanza el trabajo reemplaza el nombre
  por uno nuevo y actualizado.
- **Aislamiento del subproceso:** la ejecución de resumen usa
  `--no-extensions --no-skills --no-context-files --no-approve`, tiene un timeout de ~12s y usa tu modelo configurado.
  Podés sobrescribir el binario con `PI_RENAME_PI_COMMAND` y el modelo con `PI_RENAME_MODEL`.
- **Fallback determinístico:** si el LLM no está disponible (offline, sin API key, timeout), `/rename` convierte en slug
  el mensaje de usuario no vacío más reciente (se descarta el slash-command inicial y se corta en límite de palabra).
  Siempre produce un nombre y nunca queda bloqueado indefinidamente.
- **Pastilla del borde:** una capa externa fina del editor sobreescribe solo el render, así que no depende de
  dynamic-workflows y se compone con la etiqueta de esa extensión como `ultracode auto ── <slug>` cuando ambas están
  presentes. El nombre se renderiza en video inverso (fg/bg invertidos).
- **Mismo canal que `/name`:** los nombres se fijan vía `pi.setSessionName`, así que `/resume`, el selector de
  reanudación (`pi -r`) y `/name` sin argumentos muestran el mismo slug.

## Limitaciones y notas de seguridad

- Si no hay historial o no queda texto útil, se usa el nombre por defecto `session`; si `setSessionName` falla,
  `/rename` reporta un error en vez de romper.
- La línea de salida `Nombre de sesión: <slug> (reanudar por nombre: pi -r)` solo se imprime en la TUI sobre un TTY, y
  se mantiene en silencio cuando la sesión no tiene nombre.
- La pista de salida propia de Pi core (`To resume this session: pi --session <uuid>`) sigue siendo solo UUID por diseño
  — `--session` resuelve rutas/UUID parciales, no nombres. FR upstream para incluir el nombre:
  [earendil-works/pi#6296](https://github.com/earendil-works/pi/issues/6296).

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
