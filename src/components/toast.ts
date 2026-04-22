// ─────────────────────────────────────────────────────────────
// Toast Notifications — auto-dismissing overlay messages
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import { BoxRenderable, TextRenderable, t, fg } from "@opentui/core"
import { theme } from "../utils/theme"

type ToastType = "success" | "info" | "error" | "warning"

const toastConfig = {
    success: { border: theme.accent.green, icon: "✓" },
    info: { border: theme.accent.cyan, icon: "ℹ" },
    warning: { border: theme.accent.amber, icon: "⚠" },
    error: { border: theme.accent.pink, icon: "✗" },
} as const

let activeToast: BoxRenderable | null = null

/**
 * Show a toast notification that auto-dismisses
 */
export function showToast(
    renderer: CliRenderer,
    message: string,
    type: ToastType = "info",
    durationMs: number = 2500,
) {
    // Remove existing toast
    if (activeToast) {
        try { renderer.root.remove(activeToast.id) } catch { }
        activeToast = null
    }

    const config = toastConfig[type]

    const toast = new BoxRenderable(renderer, {
        id: `toast-${Date.now()}`,
        position: "absolute",
        bottom: 2,
        right: 2,
        width: Math.min(message.length + 8, 50),
        height: 3,
        borderStyle: "rounded",
        borderColor: config.border,
        backgroundColor: theme.bg.card,
        padding: 0,
        paddingLeft: 1,
        paddingTop: 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 1,
    })

    const iconText = new TextRenderable(renderer, {
        id: `toast-icon-${Date.now()}`,
        content: t`${fg(config.border)(config.icon)}`,
    })

    const msgText = new TextRenderable(renderer, {
        id: `toast-msg-${Date.now()}`,
        content: message,
        fg: theme.text.body,
    })

    toast.add(iconText)
    toast.add(msgText)
    renderer.root.add(toast)
    activeToast = toast

    setTimeout(() => {
        try { renderer.root.remove(toast.id) } catch { }
        if (activeToast === toast) activeToast = null
    }, durationMs)
}
