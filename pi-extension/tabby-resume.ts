import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OSC_PREFIX = "\x1b]7770;pi-resume;";
const OSC_SUFFIX = "\x07";

export default function (pi: ExtensionAPI) {
  let lastEmittedKey: string | null = null;

  function emitClear(): void {
    if (!process.stdout.isTTY) {
      return;
    }
    lastEmittedKey = null;
    process.stdout.write(`${OSC_PREFIX}clear${OSC_SUFFIX}`);
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
    const payload = {
      v: 1 as const,
      cwd,
      sessionFile,
      sessionId,
    };
    const key = JSON.stringify(payload);
    if (key === lastEmittedKey) {
      return;
    }
    lastEmittedKey = key;
    const b64 = Buffer.from(key, "utf8").toString("base64");
    process.stdout.write(`${OSC_PREFIX}start;${b64}${OSC_SUFFIX}`);
  }

  pi.on("session_start", (_event, ctx) => {
    emitStart(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    emitStart(ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    // Only clear on an explicit quit; keep state across reload/new/resume/fork.
    if (ctx.mode === "tui" && event.reason === "quit") {
      emitClear();
    }
  });
}
