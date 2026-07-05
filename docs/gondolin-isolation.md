# Aislamiento de micro-VM Gondolin (opt-in)

Fecha: 2026-06-30

[Gondolin](https://github.com/earendil-works/gondolin) es la micro-VM Linux local de pi. El paquete `pi-coding-agent` la incluye como **extensión de ejemplo** en `<pi>/examples/extensions/gondolin/`, y esa extensión redirige las herramientas internas de pi y los comandos `!` hacia la VM.

Sirve cuando querés aislar **dónde se ejecutan las herramientas**, no el ciclo de desarrollo/reload. Es el eje de **aislamiento de ejecución** de [`developing-extensions.md`](./developing-extensions.md) (eje 3).

No forma parte del paquete publicado de este repo. Se mantiene opt-in porque depende de `@earendil-works/gondolin`, una dependencia nativa pesada y específica de plataforma que ensancharía el lockfile y solo funciona en unas pocas plataformas.

## En 30 segundos

Usá Gondolin si querés que `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` y los comandos `!` corran dentro de una VM, pero sin cambiar cómo desarrollás o recargás extensiones.

```bash
npm run setup:gondolin
pi -e .pi/tools/gondolin
```

Después, dentro de la sesión de pi, `!uname -a` debe devolver **Linux**.

## Qué aísla y qué no

- **Aísla:** las herramientas internas `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` y los comandos `!` del usuario se ejecutan dentro de la VM. El cwd del host se monta en `/workspace`; todo lo que escribas debajo de `/workspace` vuelve al host.
- **No aísla:** los dynamic-workflow **subagents** lanzan procesos hijo `pi`/`codex` en el **host** (las extensiones corren donde corre `pi`). Por eso Gondolin no oculta la cadena de procesos `node → pi/codex → /bin/bash`. Para aislar todo el orquestador, ejecutá `pi` completo dentro de Docker; ver `docs/containerization.md`.

## Requisitos

- Node.js `>= 23.6.0`.
- Plataforma con runner precompilado: **`darwin-arm64`** o **`linux-x64`** solamente.
- QEMU disponible (por ejemplo, `brew install qemu` en macOS).

## Instalación

```bash
npm run setup:gondolin
```

Ese comando copia la extensión de ejemplo incluida en pi a `.pi/tools/gondolin` dentro de este repo y luego ejecuta `npm install --ignore-scripts` allí. La instalación va deliberadamente a `.pi/tools/` y no a `.pi/extensions/`, porque esta última ruta se autodetecta y levantaría una micro-VM en **cada** sesión de pi en este repo. `.pi/tools/` está ignorado por git, así que las dependencias nativas pesadas quedan fuera del control de versiones.

La instalación con `--ignore-scripts` es la ruta recomendada upstream y sin scripts: el runner `krun` ya viene como binario precompilado y `ssh2` cae a JavaScript puro sin compilar `cpu-features` de forma opcional.

## Uso

Desde la raíz de este repo:

```bash
pi -e .pi/tools/gondolin
```

Alias útil de shell:

```bash
alias pi-vm='pi -e .pi/tools/gondolin'
```

## Verificación

Dentro de la sesión de pi:

- `/gondolin` — muestra el id de la VM, el workspace del host, el workspace del guest y la shell.
- `!uname -a` — debe reportar **Linux** (no Darwin).
- `!ls -la /workspace` — debe mostrar los archivos de tu proyecto en el host.
