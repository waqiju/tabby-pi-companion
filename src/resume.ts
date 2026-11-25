import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import {
    BaseTabComponent,
    ConfigService,
    GetRecoveryTokenOptions,
    LogService,
    Logger,
    RecoveryToken,
    TabRecoveryService,
} from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'

export const OSC_TITLE_PREFIX = '__PI_RESUME__:'
const PATCHED_FLAG = Symbol('piCompanionRecoveryPatched')
const OUTPUT_SETTLE_MS = 600
const FALLBACK_DELAY_MS = 3500

export interface PiResumeState {
    v: 1
    cwd: string
    sessionFile?: string
    sessionId?: string
}

export type ParsedOscPayload =
    | { action: 'start'; state: PiResumeState }
    | { action: 'clear' }
    | null

function decodeBase64State(b64: string): ParsedOscPayload {
    if (!b64) {
        return null
    }
    try {
        const jsonStr = Buffer.from(b64, 'base64').toString('utf8')
        const parsed = JSON.parse(jsonStr)
        if (!parsed || typeof parsed !== 'object') {
            return null
        }
        const cwd = typeof parsed.c === 'string' ? parsed.c : parsed.cwd
        const sessionFile = typeof parsed.f === 'string' ? parsed.f : parsed.sessionFile
        const sessionId = typeof parsed.i === 'string' ? parsed.i : parsed.sessionId

        if (typeof cwd !== 'string' || cwd.length === 0) {
            return null
        }
        const hasFile = typeof sessionFile === 'string' && sessionFile.length > 0
        const hasId = typeof sessionId === 'string' && sessionId.length > 0
        if (!hasFile && !hasId) {
            return null
        }
        return {
            action: 'start',
            state: {
                v: 1,
                cwd,
                ...(hasFile ? { sessionFile } : {}),
                ...(hasId ? { sessionId } : {}),
            },
        }
    } catch {
        return null
    }
}

/**
 * Parses an OSC payload emitted by the pi tabby-resume extension.
 * Supports both OSC 0/2 (__PI_RESUME__:...) and legacy OSC 7770 (pi-resume;...).
 */
export function parseOscPayload(data: string): ParsedOscPayload {
    if (!data || typeof data !== 'string') {
        return null
    }
    if (data === `${OSC_TITLE_PREFIX}clear` || data === 'pi-resume;clear') {
        return { action: 'clear' }
    }
    const titleStartPrefix = `${OSC_TITLE_PREFIX}start:`
    if (data.startsWith(titleStartPrefix)) {
        return decodeBase64State(data.slice(titleStartPrefix.length))
    }
    const legacyStartPrefix = 'pi-resume;start;'
    if (data.startsWith(legacyStartPrefix)) {
        return decodeBase64State(data.slice(legacyStartPrefix.length))
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
    const target = state.sessionFile || state.sessionId
    const isPosix = state.cwd.startsWith('/') || !!state.sessionFile?.startsWith('/')
    if (isPosix) {
        // Leading space keeps bash history clean when ignorespace/ignoreboth is enabled.
        const cwd = escapePosixSingleQuoted(state.cwd)
        if (!target) {
            return ` cd '${cwd}' && pi -c\r`
        }
        const session = escapePosixSingleQuoted(target)
        return ` cd '${cwd}' && pi --session '${session}'\r`
    }
    const cwd = escapeWindowsDoubleQuoted(state.cwd)
    if (!target) {
        return `cd /d "${cwd}" && pi -c\r`
    }
    const session = escapeWindowsDoubleQuoted(target)
    return `cd /d "${cwd}" && pi --session "${session}"\r`
}

function isTerminalControlReply(data: Buffer | string): boolean {
    if (typeof data === 'string') {
        return data.length > 0 && data.charCodeAt(0) === 0x1b
    }
    return Buffer.isBuffer(data) && data.length > 0 && data[0] === 0x1b
}

/**
 * Tracks active pi session state per terminal tab and hooks Tabby's recovery serialization.
 */
@Injectable()
export class PiResumeStore {
    private states = new WeakMap<BaseTabComponent, PiResumeState>()
    private logger: Logger

    constructor(log: LogService) {
        this.logger = log.create('piCompanion')
    }

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
                    this.logger.info('Saved piResume into recovery token', state)
                }
            }
            return token
        }

        const origRecoverTab = tabRecovery.recoverTab.bind(tabRecovery)
        tabRecovery.recoverTab = async (token: RecoveryToken) => {
            const tabParams = await origRecoverTab(token)
            const piResume = (token as any)?.piResume
            if (tabParams && piResume && typeof piResume === 'object') {
                this.logger.info('Restoring piResume from recovery token', piResume)
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
    oscRegistered: boolean
}

/**
 * Listens for pi session OSC signals and triggers auto-resume on recovered tabs.
 */
@Injectable()
export class PiResumeTerminalDecorator extends TerminalDecorator {
    private cleanups = new WeakMap<BaseTerminalTabComponent<any>, AttachmentCleanup>()
    private logger: Logger

    constructor(
        private store: PiResumeStore,
        private config: ConfigService,
        log: LogService,
    ) {
        super()
        this.logger = log.create('piCompanion')
    }

    attach(terminal: BaseTerminalTabComponent<any>): void {
        super.attach(terminal)

        const cleanup: AttachmentCleanup = {
            subscriptions: [],
            oscDisposables: [],
            timers: [],
            cancelled: false,
            oscRegistered: false,
        }
        this.cleanups.set(terminal, cleanup)

        // Part A: Listen for pi resume signals via OSC 0/2 (ConPTY-safe) and OSC 7770.
        const registerOsc = () => {
            if (cleanup.cancelled || cleanup.oscRegistered) {
                return
            }
            const xterm = (terminal.frontend as any)?.xterm
            const registerOscHandler = xterm?.parser?.registerOscHandler
            if (typeof registerOscHandler !== 'function') {
                return
            }
            cleanup.oscRegistered = true

            const handleOsc = (data: string, isTitleOsc: boolean): boolean => {
                if (isTitleOsc && !data.startsWith(OSC_TITLE_PREFIX)) {
                    return false
                }
                const parsed = parseOscPayload(data)
                if (!parsed) {
                    return isTitleOsc && data.startsWith(OSC_TITLE_PREFIX)
                }
                if (parsed.action === 'start') {
                    this.store.set(terminal, parsed.state)
                    this.logger.info('Captured pi session state via OSC', parsed.state)
                } else {
                    this.store.clear(terminal)
                    this.logger.info('Cleared pi session state via OSC')
                }
                ;(terminal as any).recoveryStateChangedHint?.next()
                return true
            }

            for (const [code, isTitleOsc] of [
                [0, true],
                [2, true],
                [7770, false],
            ] as const) {
                const disposable = registerOscHandler.call(xterm.parser, code, (data: string) =>
                    handleOsc(data, isTitleOsc),
                )
                if (disposable && typeof disposable.dispose === 'function') {
                    cleanup.oscDisposables.push(disposable)
                }
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
            this.logger.info('Scheduled pi auto-resume for recovered tab', pending)
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
            const cmd = buildResumeCommand(pending)
            this.logger.info('Sending pi resume command', cmd.trim())
            if (typeof terminal.sendInput === 'function') {
                terminal.sendInput(cmd)
            }
        }

        const cancelResume = () => {
            if (fired) {
                return
            }
            fired = true
            clearResumeTimersAndSubs()
            this.logger.info('Cancelled pi auto-resume due to user input')
        }

        // Cancel auto-resume on actual user typing, ignoring ESC-prefixed terminal query replies.
        inputSub = terminal.input$.subscribe((data) => {
            if (!isTerminalControlReply(data)) {
                cancelResume()
            }
        })
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
