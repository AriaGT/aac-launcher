# AgentCraft Launcher

A small Windows desktop app that drives the AgentCraft `tools\launch.ps1` and
`tools\stop.ps1` scripts: pick a backend, start or reset a session, watch the live
Foreman and Minecraft state, and read the script output as it streams.

It is a frontend, not a reimplementation. Every start, reset and stop is a real
invocation of the scripts in your AgentCraft checkout, and the status shown is read back
from that checkout with AgentCraft's own helpers.

```
npm install
npm run dev          # Vite + Electron with hot reload
npm run dist         # portable .exe in release\
```

## What it talks to

| Concern | Source of truth |
| --- | --- |
| Starting a session | `tools\launch.ps1` |
| Stopping a session | `tools\stop.ps1` |
| Which processes are alive | `artifacts\run\*.json`, read by `resources\probe.ps1` via `tools\lib\procs.ps1` |
| Foreman health, auth, counters | `node tools\foremancli.mjs status --port N` |
| Minecraft mode, level, players | `node tools\devcli.mjs state --port N` |

`resources\probe.ps1` deliberately dot-sources `tools\lib\procs.ps1` and reuses its
`Read-JsonFile`, `Test-SameProc`, `Test-PortOpen`, `Get-LiveForeman` and `Find-GameJvm`
rules, so the launcher reports exactly what `launch.ps1` and `stop.ps1` would act on.
PID matching includes the process start time, so a recycled PID is never mistaken for a
live process.

## Options and the rules behind them

The launcher exposes a subset of what `launch.ps1` accepts, and validates it before any
process is spawned. The constraints below are enforced by the script itself, so the UI
explains them up front instead of surfacing a PowerShell error later.

- **Backend** `sim` or `claude`. `sim` needs no API key and never calls Claude.
- **Showcase** is only available on `sim`; `launch.ps1` forces the backend when
  `-Showcase` (or `-ShowcaseAt`) is present. The launcher sends `-ShowcaseAt busy|late`
  and hides the mismatch rather than letting it fail.
- **Ports** `Port` and `DevPort` must differ, and `3000`, `5173` and `8080` are reserved
  by `launch.ps1`. Blank means "let the script decide" (`7878` / `7879`).
- **Profile** must match `^[A-Za-z0-9_-]+$`, because the profile name becomes part of a
  path and a run file.
- **`-Repo`** takes git work-tree roots. `launch.ps1` splits the value on commas, so the
  launcher joins multiple paths with commas, exactly as the script expects.
- **`-Reset` is ignored while a Foreman is alive.** `launch.ps1` prints
  `-Reset ignored for a running Foreman`, so the Reset button runs
  `stop.ps1 -Foreman` first and only then `launch.ps1 -Reset`. This is the one place the
  launcher composes two script calls, and the Run tab spells out the steps before you
  press it.
- **`-NoNotify` beats `-Notify`,** and `-Dev` already suppresses agent toasts, so
  contradictory combinations are warnings rather than errors.

A stop always sends the same `-ForemanProfile`, `-AgentHome` and `-Port` the matching
launch used, including the values `launch.ps1` would have derived, so it can find and
stop what it started.

## API key handling

Only the `claude` backend needs an Anthropic key, and the app offers the alternative
(`-UseClaudeLogin`) alongside it.

- **In memory by default.** The plaintext key lives in the main process for the session
  and nowhere else.
- **Remember on this PC** encrypts it with Electron `safeStorage`, which is DPAPI on
  Windows, and writes the ciphertext to the launcher's own `userData` folder. If DPAPI is
  unavailable the checkbox is disabled and the key stays in memory.
- **Validate** issues one `GET https://api.anthropic.com/v1/models` with the
  `x-api-key` and `anthropic-version: 2023-06-01` headers. That authenticates the key
  without spending tokens; a Messages API call would cost money just to prove it works.
- **Never in a command line.** The key reaches `launch.ps1` only as
  `ANTHROPIC_API_KEY` in the child process environment. It is not an argument, not in a
  log line, not in the AgentCraft checkout and not in this repository.
- **Never displayed.** The UI shows a masked hint only, and every line of console output
  is passed through a redactor that masks the key by value and by `sk-ant-…` shape.

## Security posture

Following Electron's own recommendations:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- a CommonJS preload that exposes a fixed function list through `contextBridge`; there is
  no generic `invoke(channel, …)` escape hatch
- the renderer is loaded from a privileged `app://` scheme, not `file://`, and is served
  with a CSP that forbids remote script and `eval`
- navigation and `window.open` are blocked; `https://` links go to the system browser
- all permission requests and permission checks are denied
- every IPC payload is re-validated by the parsers in `src\shared\ipc.ts` before it
  reaches the filesystem, the settings file or PowerShell. No channel accepts a command
  string or an arbitrary executable.

Closing the window never kills AgentCraft processes. They belong to your checkout, and
`stop.ps1` is the only sanctioned way to end them.

## Layout

```
src/
  main/        Electron main: IPC, operation controller, status service, safeStorage
  preload/     contextBridge allowlist
  renderer/    React UI
  shared/      types, command building, validation, redaction, IPC contract
resources/
  probe.ps1    status probe; reuses tools\lib\procs.ps1 from your checkout
tests/         Vitest unit tests
```

The main process is the only place that spawns PowerShell. `src\shared\command-builder.ts`
builds the argument array as data, and no renderer-supplied string is ever concatenated
into a shell.

## Requirements

- Windows 10 or 11 with Windows PowerShell 5.1 (used directly from
  `%SystemRoot%\System32\WindowsPowerShell\v1.0`)
- Node.js 22+ on `PATH` — AgentCraft's own CLIs are Node scripts, and deep status needs it
- A real AgentCraft checkout containing `tools\launch.ps1` and `tools\stop.ps1`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server plus Electron, with reload |
| `npm run typecheck` | `tsc --noEmit` for the electron and web projects |
| `npm run test` | Vitest unit tests |
| `npm run test:integration` | build, then run the Electron checks in `tests\integration\` |
| `npm run build` | compile main/preload with `tsc`, build the renderer with Vite |
| `npm run dist:dir` | unpacked build in `release\`, for a quick smoke test |
| `npm run dist` | portable x64 `.exe` |
| `npm run clean` | remove `out\`, `dist\` and `release\` |
| `npm run icon` | regenerate `build\icon.ico` |