import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'

export const CTRL_ENTER_HOTKEY_ID = 'send-ctrl-enter'

interface TerminalLikeTab extends BaseTabComponent {
    sendInput(data: string | Buffer): void
}

function isSplitTab(tab: BaseTabComponent): tab is SplitTabComponent {
    return typeof (tab as SplitTabComponent).getFocusedTab === 'function'
}

function isTerminalLikeTab(tab: BaseTabComponent | null | undefined): tab is TerminalLikeTab {
    return !!tab && typeof (tab as TerminalLikeTab).sendInput === 'function'
}

/**
 * Forwards Ctrl+Enter as Kitty CSI 13;5u to the focused terminal pane.
 */
export function sendCtrlEnter(app: AppService): void {
    const activeEl = document.activeElement
    if (
        activeEl instanceof HTMLInputElement ||
        (activeEl instanceof HTMLTextAreaElement && !activeEl.classList.contains('xterm-helper-textarea'))
    ) {
        return
    }
    const activeTab = app.activeTab
    if (!activeTab) {
        return
    }
    const focusedTab = isSplitTab(activeTab) ? activeTab.getFocusedTab() : activeTab
    if (isTerminalLikeTab(focusedTab)) {
        focusedTab.sendInput('\x1b[13;5u')
    }
}
