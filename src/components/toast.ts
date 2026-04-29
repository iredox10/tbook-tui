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

const MAX_TOASTS = 3
const activeToasts: { box: BoxRenderable; timer: ReturnType<typeof setTimeout> }[] = []

/**
 * Show a toast notification that auto-dismisses.
 * Supports stacking up to MAX_TOASTS with slide-in animation.
 */
export function showToast(
    renderer: CliRenderer,
    message: string,
    type: ToastType = "info",
    durationMs: number = 2500,
) {
    // Shift existing toasts up
    while (activeToasts.length >= MAX_TOASTS) {
        const oldest = activeToasts.shift()
        if (oldest) {
            clearTimeout(oldest.timer)
            try { renderer.root.remove(oldest.box.id) } catch { }
        }
    }

    // Slide existing toasts up by adjusting their bottom position
    for (let i = 0; i < activeToasts.length; i++) {
        const t = activeToasts[i]
        if (t) {
            t.box.bottom = 2 + (activeToasts.length - i) * 3
        }
    }

    const config = toastConfig[type]
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const toast = new BoxRenderable(renderer, {
        id,
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
        id: `toast-icon-${id}`,
        content: t`${fg(config.border)(config.icon)}`,
    })

    const msgText = new TextRenderable(renderer, {
        id: `toast-msg-${id}`,
        content: message,
        fg: theme.text.body,
    })

    toast.add(iconText)
    toast.add(msgText)
    renderer.root.add(toast)

    // Animate in: start off-screen (right + 10) then slide in
    toast.right = 12
    let frame = 0
    const animateIn = setInterval(() => {
        frame++
        toast.right = Math.max(2, 12 - frame * 2)
        if (toast.right <= 2) {
            clearInterval(animateIn)
            toast.right = 2
        }
    }, 40)

    const timer = setTimeout(() => {
        clearInterval(animateIn)
        // Animate out
        let outFrame = 0
        const animateOut = setInterval(() => {
            outFrame++
            toast.right = 2 + outFrame * 2
            if (toast.right >= 12) {
                clearInterval(animateOut)
                try { renderer.root.remove(toast.id) } catch { }
                const idx = activeToasts.findIndex(t => t.box.id === id)
                if (idx >= 0) activeToasts.splice(idx, 1)
                // Reposition remaining toasts
                for (let i = 0; i < activeToasts.length; i++) {
                    const t = activeToasts[i]
                    if (t) t.box.bottom = 2 + (activeToasts.length - 1 - i) * 3
                }
            }
        }, 40)
    }, durationMs)

    activeToasts.push({ box: toast, timer })
}

/**
 * Dismiss all active toasts immediately
 */
export function dismissAllToasts(renderer: CliRenderer) {
    for (const t of activeToasts) {
        clearTimeout(t.timer)
        try { renderer.root.remove(t.box.id) } catch { }
    }
    activeToasts.length = 0
}
