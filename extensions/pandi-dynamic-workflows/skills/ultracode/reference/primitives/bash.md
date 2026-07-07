# bash

`bash()` ejecuta un comando de shell en el `cwd` del run y devuelve su salida capturada. Usalo cuando un paso del workflow necesite una sonda o comando barato y determinista — listar archivos, correr un build/test, invocar `git` — y no una llamada a un LLM (para eso está `agent()`).

```js
const { stdout } = await bash("git ls-files '*.ts'", { cache: true });
const files = stdout.split("\n").filter(Boolean);
log(`work-list: ${files.length} files`);
```

**Runtime:** pi runtime

**Firma:** `bash(command, options?) → Promise<BashResult>`

## Referencia rápida

**Opciones:** `{ cwd?, timeoutMs?, throwOnError?, cache? }` — todas opcionales.
`cwd` por defecto es el `cwd` del run, `timeoutMs` por defecto usa el timeout del agent del run, y `throwOnError` hace throw en vez de devolver un resultado fallido.

**Devuelve:** un `BashResult`:

```ts
{ ok: boolean, code: number, killed: boolean, elapsedMs: number, stdout: string, stderr: string }
```

## Cuándo usarlo

- **Sí** para sondas deterministas, baratas y con pocos efectos colaterales (`git ls-files`, `rg`, invocaciones de build/test) que alimentan el workflow.
- **No** para algo que quieras con cache por defecto (no lo tiene; ver Cosas a tener en cuenta) ni para comandos no confiables o destructivos sin cuidado.

## Advertencias

- **El cache es opt-in.** A diferencia de `agent()`, que cachea por defecto, `bash()` solo cachea cuando pasás `{ cache: true }`. Sin eso, el comando se vuelve a ejecutar completo en cada resume.
- Un comando cuyos argumentos dependan de `Date.now()` o `Math.random()` no va a producir una cache key estable y se volverá a ejecutar en cada resume incluso con `cache: true`.
- Corre un shell real (`bash -lc command`); tratá su stdout/stderr como datos **untrusted** antes de reutilizarlos en prompts o decisiones.
- `throwOnError: true` lanza `Error("Command failed (<code>): <command>")` con stderr/stdout anexados. Usalo cuando un fallo deba abortar el paso en vez de manejarse inline.

## Example

```js
export default async function main() {
  const changed = await bash("git diff --name-only origin/main...HEAD", {
    cache: true,
  });
  const files = changed.stdout.split("\n").filter(Boolean);
  if (files.length === 0) return "no changed files";

  const test = await bash("npm test", { timeoutMs: 120_000, throwOnError: false });
  return test.ok ? `tests passed for ${files.length} files` : `tests failed:\n${test.stderr}`;
}
```
