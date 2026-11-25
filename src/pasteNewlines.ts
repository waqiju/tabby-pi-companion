import { ConfigService, HostAppService, Platform } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

const PASTE_PATCHED_FLAG = Symbol('piCompanionPastePatched')

/**
 * Normalizes bare LF (`\n`) to CRLF (`\r\n`) while leaving existing `\r\n` and bare `\r` intact.
 * Tabby's Windows paste handler only replaces `\r\n` with `\r`; converting bare `\n` upfront
 * prevents `\n` (`0x0A`) from reaching Windows ConPTY, which translates it to Ctrl+Enter.
 */
export function normalizeClipboardNewlinesForWindows(text: string): string {
    return text.replace(/\r?\n/g, '\r\n')
}

/**
 * Patches `BaseTerminalTabComponent.prototype.paste` on Windows so clipboard text read
 * during paste has bare LF line endings normalized to CRLF before Tabby strips `\r\n` to `\r`.
 */
export function patchWindowsPasteNewlines(hostApp: HostAppService, config: ConfigService): void {
    if (hostApp.platform !== Platform.Windows) {
        return
    }

    const proto = BaseTerminalTabComponent?.prototype as any
    if (!proto || typeof proto.paste !== 'function' || proto[PASTE_PATCHED_FLAG]) {
        return
    }

    proto[PASTE_PATCHED_FLAG] = true
    const origPaste = proto.paste

    proto.paste = function (...args: any[]): any {
        if (config.store.piCompanion?.normalizePasteNewlines === false) {
            return origPaste.apply(this, args)
        }

        const platform = this?.platform
        if (!platform || typeof platform.readClipboard !== 'function') {
            return origPaste.apply(this, args)
        }

        const hasOwn = Object.prototype.hasOwnProperty.call(platform, 'readClipboard')
        const origReadClipboard = platform.readClipboard
        platform.readClipboard = function (...cbArgs: any[]): any {
            const raw = origReadClipboard.apply(this, cbArgs)
            return typeof raw === 'string' ? normalizeClipboardNewlinesForWindows(raw) : raw
        }

        try {
            return origPaste.apply(this, args)
        } finally {
            if (hasOwn) {
                platform.readClipboard = origReadClipboard
            } else {
                delete platform.readClipboard
            }
        }
    }
}
