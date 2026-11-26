import { Injector } from '@angular/core'
import { ConfigService, HostAppService, LogService, Platform } from 'tabby-core'

export const TABBY_PI_COMPANION_ENV = 'TABBY_PI_COMPANION'
export const TABBY_PI_COMPANION_WSLENV_ENTRY = 'TABBY_PI_COMPANION/u'

const PATCHED_PTY_FLAG = Symbol('piCompanionPtySpawnPatched')

/**
 * Returns a new environment object with `TABBY_PI_COMPANION=1`, and on Windows
 * appends `TABBY_PI_COMPANION/u` to `WSLENV` (preserving case and existing entries)
 * so WSL guest shells inherit the marker.
 */
export function injectCompanionEnv(
    env: Record<string, string> | undefined,
    isWindows: boolean,
): Record<string, string> {
    const nextEnv: Record<string, string> = { ...(env ?? {}) }

    for (const key of Object.keys(nextEnv)) {
        if (key.toUpperCase() === TABBY_PI_COMPANION_ENV && key !== TABBY_PI_COMPANION_ENV) {
            delete nextEnv[key]
        }
    }
    nextEnv[TABBY_PI_COMPANION_ENV] = '1'

    if (isWindows) {
        const existingWslenvKey = Object.keys(nextEnv).find((key) => /^wslenv$/i.test(key))
        const wslenvKey = existingWslenvKey ?? 'WSLENV'
        const rawValue = nextEnv[wslenvKey] ?? ''
        const entries = rawValue.split(':').filter((entry) => entry.length > 0)
        const alreadyPresent = entries.some(
            (entry) => entry.split('/')[0].toUpperCase() === TABBY_PI_COMPANION_ENV,
        )
        if (!alreadyPresent) {
            entries.push(TABBY_PI_COMPANION_WSLENV_ENTRY)
        }
        nextEnv[wslenvKey] = entries.join(':')
    }

    return nextEnv
}

/**
 * Wraps `PTYInterface.spawn` from `tabby-local` so local and WSL PTYs spawned
 * by Tabby receive `TABBY_PI_COMPANION=1` when auto-resume is enabled.
 */
export function patchLocalPtySpawn(
    injector: Injector,
    hostApp: HostAppService,
    config: ConfigService,
    log: LogService,
): void {
    let PTYInterface: any
    try {
        // tabby-local is a Tabby builtin plugin externalized by webpack (/^tabby-/).
        PTYInterface = require('tabby-local')?.PTYInterface
    } catch {
        return
    }
    if (!PTYInterface) {
        return
    }

    const ptyInterface = injector.get(PTYInterface, null) as any
    if (!ptyInterface || typeof ptyInterface.spawn !== 'function' || ptyInterface[PATCHED_PTY_FLAG]) {
        return
    }

    ptyInterface[PATCHED_PTY_FLAG] = true
    const origSpawn = ptyInterface.spawn

    ptyInterface.spawn = function (...args: any[]): any {
        const patchedArgs = [...args]
        if (
            config.store?.piCompanion?.autoResume !== false &&
            patchedArgs[2] &&
            typeof patchedArgs[2] === 'object'
        ) {
            patchedArgs[2] = {
                ...patchedArgs[2],
                env: injectCompanionEnv(patchedArgs[2].env, hostApp.platform === Platform.Windows),
            }
        }
        return origSpawn.apply(ptyInterface, patchedArgs)
    }

    log.create('piCompanion').info('Patched PTYInterface.spawn to inject TABBY_PI_COMPANION')
}
