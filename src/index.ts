import { Injectable, NgModule, OnDestroy } from '@angular/core'
import { Subject, takeUntil } from 'rxjs'
import {
    AppService,
    ConfigProvider,
    ConfigService,
    HostAppService,
    HotkeyDescription,
    HotkeyProvider,
    HotkeysService,
    TabRecoveryService,
} from 'tabby-core'
import { TerminalDecorator } from 'tabby-terminal'
import { CTRL_ENTER_HOTKEY_ID, sendCtrlEnter } from './ctrlEnter'
import { patchWindowsPasteNewlines } from './pasteNewlines'
import { PiResumeStore, PiResumeTerminalDecorator } from './resume'

@Injectable()
export class PiCompanionConfigProvider extends ConfigProvider {
    defaults = {
        hotkeys: {
            [CTRL_ENTER_HOTKEY_ID]: ['Ctrl-Enter'],
        },
        piCompanion: {
            autoResume: true,
            normalizePasteNewlines: true,
        },
    }
}

@Injectable()
export class PiCompanionHotkeyProvider extends HotkeyProvider {
    async provide(): Promise<HotkeyDescription[]> {
        return [
            {
                id: CTRL_ENTER_HOTKEY_ID,
                name: 'Send Ctrl+Enter (CSI 13;5u)',
            },
        ]
    }
}

@Injectable()
export class PiCompanionService implements OnDestroy {
    private destroyed$ = new Subject<void>()

    constructor(
        private app: AppService,
        hotkeys: HotkeysService,
        tabRecovery: TabRecoveryService,
        store: PiResumeStore,
        hostApp: HostAppService,
        config: ConfigService,
    ) {
        patchWindowsPasteNewlines(hostApp, config)
        store.patchTabRecovery(tabRecovery)
        hotkeys.hotkey$
            .pipe(takeUntil(this.destroyed$))
            .subscribe((id) => {
                if (id === CTRL_ENTER_HOTKEY_ID) {
                    sendCtrlEnter(this.app)
                }
            })
    }

    ngOnDestroy(): void {
        this.destroyed$.next()
        this.destroyed$.complete()
    }
}

@NgModule({
    providers: [
        { provide: ConfigProvider, useClass: PiCompanionConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: PiCompanionHotkeyProvider, multi: true },
        { provide: TerminalDecorator, useClass: PiResumeTerminalDecorator, multi: true },
        PiResumeStore,
        PiCompanionService,
    ],
})
export default class PiCompanionModule {
    constructor(_service: PiCompanionService) {}
}
