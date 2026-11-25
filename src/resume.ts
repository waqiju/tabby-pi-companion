import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import {
    BaseTabComponent,
    ConfigService,
    GetRecoveryTokenOptions,
    RecoveryToken,
    TabRecoveryService,
} from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'

export const OSC_CODE = 7770
const PATCHED_FLAG = Symbol('piCompanionRecoveryPatched')
const OUTPUT_SETTLE_MS = 600
const FALLBACK_DELAY_MS = 3500

export interface PiResumeState {
    v: 1
    cwd: string
    sessionFile: string
    sessionId?: string
}

export type ParsedOscPayload =
    | { action: 'start'; state: PiResumeState }
    | { action: 'clear' }
    | null

/**
 * Parses an OSC 7770 payload emitted by the pi tabby-resume extension.
 */
export function parseOscPayload(data: string): ParsedOscPayload {
    if (!data || typeof data !== 'string') {
        return null
    }
    if (data === 'pi-resume;clear') {
        return { action: 'clear' }
    }
    const prefix = 'pi-resume;start;'
    if (!data.startsWith(prefix)) {
        return null
    }
    const b64 = data.slice(prefix.length)
    if (!b64) {
        return null
    }
    try {
        const jsonStr = Buffer.from(b64, 'base64').toString('utf8')
        const parsed = JSON.parse(jsonStr)
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.cwd === 'string' &&
            parsed.cwd.length > 0 &&
            typeof parsed.sessionFile === 'string' &&
            parsed.sessionFile.length > 0
        ) {
            return {
                action: 'start',
                state: {
                    v: 1,
                    cwd: parsed.cwd,
                    sessionFile: parsed.sessionFile,
                    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
                },
            }
        }
    } catch {
        return null
    }
    return null
}

function escapePosixSingleQuoted(value: string): string {
    return value.replace(/'/g, "'\\''")
}

function escapeWindowsDoubleQuoted(value: string): string {
    return value.replace(/"/g, '\\"')
}

/**
 * Builds the shell command used to restore a pi session in its original directory.
 */
export function buildResumeCommand(state: PiResumeState): string {
    const isPosix = state.cwd.startsWith('/') || state.sessionFile.startsWith('/')
    if (isPosix) {
        // Leading space keeps bash history clean when ignorespace/ignoreboth is enabled.
        const cwd = escapePosixSingleQuoted(state.cwd)
        const session = escapePosixSingleQuoted(state.sessionFile)
        return ` cd '${cwd}' && pi --session '${session}'\r`
    }
    const cwd = escapeWindowsDoubleQuoted(state.cwd)
    const session = escapeWindowsDoubleQuoted(state.sessionFile)
    return `cd /d "${cwd}" && pi --session "${session}"\r`
}

/**
 * Tracks active pi session state per terminal tab and hooks Tabby's recovery serialization.
 */
@Injectable()
export class PiResumeStore {
    private states = new WeakMap<BaseTabComponent, PiResumeState>()

    get(tab: BaseTabComponent): PiResumeState | undefined {
        return this.states.get(tab)
    }

    set(tab: BaseTabComponent, state: PiResumeState): void {
        this.states.set(tab, state)
    }

    clear(tab: BaseTabComponent): void {
        this.states.delete(tab)
    }

    patchTabRecovery(tabRecovery: TabRecoveryService): void {
        const target = tabRecovery as any
        if (!target || target[PATCHED_FLAG]) {
            return
        }
        target[PATCHED_FLAG] = true

        const origGetFull = tabRecovery.getFullRecoveryToken.bind(tabRecovery)
        tabRecovery.getFullRecoveryToken = async (
            tab: BaseTabComponent,
            options?: GetRecoveryTokenOptions,
        ): Promise<RecoveryToken | null> => {
            const token = await origGetFull(tab, options)
            if (token && options?.includeState) {
                const state = this.states.get(tab)
                if (state) {
                    (token as any).piResume = state
                }
            }
            return token
        }

        const origRecoverTab = tabRecovery.recoverTab.bind(tabRecovery)
        tabRecovery.recoverTab = async (token: RecoveryToken) => {
            const tabParams = await origRecoverTab(token)
            const piResume = (token as any)?.piResume
            if (tabParams && piResume && typeof piResume === 'object') {
                tabParams.inputs = {
                    ...(tabParams.inputs ?? {}),
                    __piResume: piResume,
                }
            }
            return tabParams
        }
    }
}

interface AttachmentCleanup {
    subscriptions: Subscription[]
    oscDisposables: Array<{ dispose(): void }>
    timers: ReturnType<typeof setTimeout>[]
    cancelled: boolean
}

/**
 * Listens for OSC 7770 pi session signals and triggers auto-resume on recovered tabs.
 */
@Injectable()
export class PiResumeTerminalDecorator extends TerminalDecorator {
    private cleanups = new WeakMap<BaseTerminalTabComponent<any>, AttachmentCleanup>()

    constructor(
        private store: PiResumeStore,
        private config: ConfigService,
    ) {
        super()
    }

    attach(terminal: BaseTerminalTabComponent<any>): void {
        super.attach(terminal)

        const cleanup: AttachmentCleanup = {
            subscriptions: [],
            oscDisposables: [],
            timers: [],
            cancelled: false,
        }
        this.cleanups.set(terminal, cleanup)

        // Part A: Listen for OSC 7770 from pi extension.
        const registerOsc = () => {
            if (cleanup.cancelled) {
                return
            }
            const xterm = (terminal.frontend as any)?.xterm
            const registerOscHandler = xterm?.parser?.registerOscHandler
            if (typeof registerOscHandler !== 'function') {
                return
            }
            const disposable = registerOscHandler.call(xterm.parser, OSC_CODE, (data: string) => {
                const parsed = parseOscPayload(data)
                if (!parsed) {
                    return false
                }
                if (parsed.action === 'start') {
                    this.store.set(terminal, parsed.state)
                } else {
                    this.store.clear(terminal)
                }
                ;(terminal as any).recoveryStateChangedHint?.next()
                return true
            })
            if (disposable && typeof disposable.dispose === 'function') {
                cleanup.oscDisposables.push(disposable)
            }
        }

        if (terminal.frontendIsReady) {
            registerOsc()
        }
        cleanup.subscriptions.push(
            terminal.frontendReady$.subscribe(() => registerOsc()),
        )

        // Part B: Auto-resume on recovered tab.
        const pending: PiResumeState | undefined = (terminal as any).__piResume
        delete (terminal as any).__piResume

        if (pending && this.config.store?.piCompanion?.autoResume !== false) {
            // Preserve state immediately in case Tabby is terminated again before pi emits OSC.
            this.store.set(terminal, pending)
            this.scheduleResume(terminal, pending, cleanup)
        }
    }

    private scheduleResume(
        terminal: BaseTerminalTabComponent<any>,
        pending: PiResumeState,
        cleanup: AttachmentCleanup,
    ): void {
        let fired = false
        let sessionSub: Subscription | null = null
        let outputSub: Subscription | null = null
        let inputSub: Subscription | null = null

        const clearResumeTimersAndSubs = () => {
            cleanup.timers.forEach(t => clearTimeout(t))
            cleanup.timers = []
            sessionSub?.unsubscribe()
            sessionSub = null
            outputSub?.unsubscribe()
            outputSub = null
            inputSub?.unsubscribe()
            inputSub = null
        }

        const fireResume = () => {
            if (fired || cleanup.cancelled) {
                return
            }
            fired = true
            clearResumeTimersAndSubs()
            if (typeof terminal.sendInput === 'function') {
                terminal.sendInput(buildResumeCommand(pending))
            }
        }

        const cancelResume = () => {
            if (fired) {
                return
            }
            fired = true
            clearResumeTimersAndSubs()
        }

        // Cancel auto-resume if the user types manually before it runs.
        inputSub = terminal.input$.subscribe(() => cancelResume())
        cleanup.subscriptions.push(inputSub)

        const attachToSession = (session: NonNullable<BaseTerminalTabComponent<any>['session']>) => {
            if (fired || cleanup.cancelled) {
                return
            }

            // Fallback timer in case shell prompt emits nothing within 3.5s.
            const fallbackTimer = setTimeout(fireResume, FALLBACK_DELAY_MS)
            cleanup.timers.push(fallbackTimer)

            let outputTriggered = false
            outputSub = session.output$.subscribe((chunk: string) => {
                if (outputTriggered || fired || cleanup.cancelled) {
                    return
                }
                if (chunk && chunk.length > 0) {
                    outputTriggered = true
                    const settleTimer = setTimeout(fireResume, OUTPUT_SETTLE_MS)
                    cleanup.timers.push(settleTimer)
                }
            })
            cleanup.subscriptions.push(outputSub)
        }

        if (terminal.session) {
            attachToSession(terminal.session)
        } else {
            sessionSub = terminal.sessionChanged$.subscribe((session) => {
                if (session) {
                    sessionSub?.unsubscribe()
                    sessionSub = null
                    attachToSession(session)
                }
            })
            cleanup.subscriptions.push(sessionSub)
        }
    }

    detach(terminal: BaseTerminalTabComponent<any>): void {
        const cleanup = this.cleanups.get(terminal)
        if (cleanup) {
            cleanup.cancelled = true
            cleanup.timers.forEach(t => clearTimeout(t))
            cleanup.timers = []
            cleanup.subscriptions.forEach(s => s.unsubscribe())
            cleanup.subscriptions = []
            cleanup.oscDisposables.forEach(d => d.dispose())
            cleanup.oscDisposables = []
            this.cleanups.delete(terminal)
        }
        super.detach(terminal)
    }
}
