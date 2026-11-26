import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OSC_PREFIX = "\x1b]0;__PI_RESUME__:";
const OSC_SUFFIX = "\x07";
const STARTUP_DELAY_MS = 350;
const MAX_COMPACT_B64_LEN = 200;

function isTabbyCompanionActive(): boolean {
  if (process.env.TABBY_PI_COMPANION !== "1") {
    return false;
  }
  // Avoid polluting tmux/screen titles when nested inside a Tabby tab.
  if (process.env.TMUX || process.env.STY) {
    return false;
  }
  return true;
}

export default function (pi: ExtensionAPI) {
  if (!isTabbyCompanionActive()) {
    return;
  }

  let lastEmittedKey: string | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;

  function clearStartupTimer(): void {
    if (startupTimer !== null) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
  }

  function emitClear(): void {
    clearStartupTimer();
    if (!process.stdout.isTTY) {
      return;
    }
    lastEmittedKey = null;
    process.stdout.write(`${OSC_PREFIX}clear${OSC_SUFFIX}`);
  }

  function buildCompactB64(cwd: string, sessionFile: string, sessionId: string | undefined): string {
    const withFile = JSON.stringify({ c: cwd, f: sessionFile });
    const withFileB64 = Buffer.from(withFile, "utf8").toString("base64");
    if (withFileB64.length <= MAX_COMPACT_B64_LEN || !sessionId) {
      return withFileB64;
    }
    const withId = JSON.stringify({ c: cwd, i: sessionId });
    return Buffer.from(withId, "utf8").toString("base64");
  }

  function emitStart(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !process.stdout.isTTY) {
      return;
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      // Ephemeral (--no-session) sessions have no file to resume.
      emitClear();
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
    const key = JSON.stringify({ cwd, sessionFile, sessionId });
    if (key === lastEmittedKey) {
      return;
    }
    lastEmittedKey = key;
    const b64 = buildCompactB64(cwd, sessionFile, sessionId);
    process.stdout.write(`${OSC_PREFIX}start:${b64}${OSC_SUFFIX}`);
  }

  pi.on("session_start", (_event, ctx) => {
    clearStartupTimer();
    lastEmittedKey = null;
    // Delay slightly so ConPTY does not coalesce this with pi's own startup title write.
    startupTimer = setTimeout(() => {
      startupTimer = null;
      emitStart(ctx);
    }, STARTUP_DELAY_MS);
  });

  pi.on("turn_end", (_event, ctx) => {
    clearStartupTimer();
    emitStart(ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    clearStartupTimer();
    // Only clear on an explicit quit; keep state across reload/new/resume/fork.
    if (ctx.mode === "tui" && event.reason === "quit") {
      emitClear();
    }
  });
}
