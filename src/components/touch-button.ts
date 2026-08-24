// ─────────────────────────────────────────────────────────────
// Touch Button — small tappable text button for pointer navigation.
//
// Gives touch/mouse users access to keyboard-only commands. Rendered as a
// bracketed label (e.g. `[ 🔍 Search ]`) with tap detection attached; all
// taps respect the global mouseEnabled gate via enableTap.
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import { TextRenderable, t, bold, fg } from "@opentui/core"
import { getTheme } from "../utils/theme"
import { enableTap } from "../utils/touch"

export interface TouchButtonOptions {
    renderer: CliRenderer
    id: string
    /** Button text without icon/brackets, e.g. "Search". */
    label: string
    /** Optional glyph shown before the label. */
    icon?: string
    /** Theme color for the label/icon (defaults to accent.cyan). */
    accent?: string
    onTap: () => void
}

export function createTouchButton(opts: TouchButtonOptions): TextRenderable {
    const th = getTheme()
    const accent = opts.accent ?? th.accent.cyan
    const icon = opts.icon ? `${opts.icon} ` : ""

    const btn = new TextRenderable(opts.renderer, {
        id: opts.id,
        content: t`${fg(th.border.focused)("[ ")}${bold(fg(accent)(`${icon}${opts.label}`))}${fg(th.border.focused)(" ]")}`,
        // Non-selectable so presses reach enableTap instead of text selection.
        selectable: false,
    })

    enableTap(btn, opts.onTap)
    return btn
}
