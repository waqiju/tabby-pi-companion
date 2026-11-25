# tabby-pi-companion

Companion plugin for [Tabby Terminal](https://tabby.sh/) and the `pi` coding agent (`@earendil-works/pi-coding-agent`).

## Features

- **Auto-Resume `pi` Sessions on Tab Recovery**:
  - When a `pi` TUI session is active in a terminal tab and Tabby exits or restarts (or crashes), Tabby automatically runs `cd <cwd> && pi --session <sessionFile>` after recovering the tab.
  - Works seamlessly across WSL and POSIX/Windows shells using the exact `cwd` and session file reported by `pi`.
  - Normal `pi` quit clears the pending resume state so closed sessions are not relaunched.
  - Typing into the recovered shell before the auto-resume triggers cancels it immediately.
- **Send Ctrl+Enter (`CSI 13;5u`)** (`Ctrl-Enter` by default):
  - Forwards `Ctrl+Enter` as `\x1b[13;5u` (Kitty keyboard protocol) to the focused terminal pane, enabling multiline vs. submit distinction in `pi` TUI extensions (e.g., `smart-enter`).
  - Customizable or removable anytime in **Settings → Hotkeys → Send Ctrl+Enter (CSI 13;5u)**.

## How Auto-Resume Works (ConPTY-safe OSC `0`)

1. The bundled `pi` extension (`pi-extension/tabby-resume.ts`) hooks `session_start`, `turn_end`, and `session_shutdown`.
2. In interactive `tui` mode, it writes an OSC `0` control sequence to `stdout` (chosen because Windows ConPTY strips custom OSC codes like `7770`, while reliably forwarding OSC `0`):
   - Start/update: `\x1b]0;__PI_RESUME__:start:<base64-json>\x07` where `<base64-json>` encodes compact `{ c: cwd, f: sessionFile }` (falling back to `{ c: cwd, i: sessionId }` if the path would exceed ConPTY's title limit).
   - Clean exit (`reason === "quit"`): `\x1b]0;__PI_RESUME__:clear\x07`.
3. `PiResumeTerminalDecorator` registers `xterm.parser.registerOscHandler(0, ...)` (and `2` / `7770`), silently swallowing `__PI_RESUME__:` payloads before they touch the tab title, and updates `PiResumeStore` + `recoveryStateChangedHint` so Tabby persists `localStorage.tabsRecovery`.
4. `TabRecoveryService` is wrapped to attach `piResume` only when `includeState` is true (preserving normal tab duplication) and pass `__piResume` into recovered terminal tab inputs on startup.
5. Once the recovered terminal's session produces its first output (600ms settle, or 3.5s fallback), the plugin injects the resume command into the PTY.

## Configuration

In Tabby's config (`config.yaml`):

```yaml
piCompanion:
  autoResume: true # set to false to disable auto-resume while keeping Ctrl+Enter
```

## Development & Deployment

```bash
npm install --legacy-peer-deps
npm run deploy
```

`npm run deploy` builds `dist/index.js`, deploys the Tabby plugin (`package.json` + `dist/`) into `%APPDATA%\tabby\plugins\node_modules\tabby-pi-companion`, and copies `pi-extension/tabby-resume.ts` into `~/.pi/agent/extensions/tabby-resume.ts`.

Restart Tabby (and `/reload` or restart `pi`) after deploying to load changes.
