// ─────────────────────────────────────────────────────────────
// Touch / pointer helpers for TUI navigation.
//
// Most modern terminals translate touch → mouse events via the SGR
// protocol (touch-drag = mouse drag, tap = click, two-finger = wheel).
// OpenTUI's ScrollBox already handles wheel natively; these helpers add:
//   - enableTouchScroll:  one-finger drag-to-pan (+ optional long-press-select)
//   - enableTap:          tap-to-activate on a single renderable (list rows)
//   - enableSelectTap:    tap-to-select-item on a SelectRenderable
// ─────────────────────────────────────────────────────────────

import type { CliRenderer, MouseEvent, Renderable, ScrollBoxRenderable, SelectRenderable } from "@opentui/core"

const LONG_PRESS_MS = 350
const TAP_MOVE_THRESHOLD = 4
const TAP_MAX_MS = 600

export interface TouchScrollOptions {
    renderer?: CliRenderer
    /** Enable long-press → native text selection (reader body only). */
    enableLongPressSelect?: boolean
    /** Called on a tap (down→up, no drag) anywhere on the scroll area. */
    onTap?: (e: MouseEvent) => void
}

/**
 * Attach one-finger drag-to-pan scrolling to a ScrollBox.
 *
 * - Quick drag = scroll (maps touch-drag to scrollBy).
 * - Two-finger/wheel scroll already works natively (unchanged).
 * - With `enableLongPressSelect`: a 350ms hold without movement arms
 *   native text selection; subsequent drag extends the selection, and
 *   release finishes it. This gives reader-style "long-press to select"
 *   in a single gesture while keeping drag = scroll by default.
 * - With `onTap`: a quick down→up with no drag fires the tap callback.
 *
 * NOTE: drag-to-pan requires the content's text to be `selectable: false`,
 * otherwise the renderer intercepts left-drag for text selection.
 */
export function enableTouchScroll(scrollBox: ScrollBoxRenderable, opts: TouchScrollOptions = {}) {
    let mode: "idle" | "pending" | "scroll" | "select" = "idle"
    let lastY = 0
    let downX = 0
    let downY = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let armedTarget: Renderable | null = null
    let armedDragged = false

    scrollBox.onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return
        // Neutralize any text-selection the renderer auto-started on `down`
        // over selectable text, so a subsequent drag pans instead of selecting.
        // (No-op when there's no active selection; cheap.)
        if (opts.renderer) {
            try { opts.renderer.clearSelection() } catch { }
        }
        mode = "pending"
        downX = e.x
        downY = e.y
        lastY = e.y
        armedDragged = false
        if (opts.enableLongPressSelect && opts.renderer && e.target) {
            timer = setTimeout(() => {
                if (mode !== "pending") return
                const target = e.target
                if (!target) return
                target.selectable = true
                try {
                    opts.renderer!.startSelection(target, e.x, e.y)
                    armedTarget = target
                    mode = "select"
                } catch {
                    target.selectable = false
                    mode = "scroll"
                }
            }, LONG_PRESS_MS)
        }
    }

    scrollBox.onMouseDrag = (e: MouseEvent) => {
        if (e.button !== 0) return
        if (mode === "select") {
            armedDragged = true
            return
        }
        if (mode === "pending") {
            const moved =
                Math.abs(e.x - downX) > TAP_MOVE_THRESHOLD ||
                Math.abs(e.y - downY) > TAP_MOVE_THRESHOLD
            if (!moved) return
            if (timer) {
                clearTimeout(timer)
                timer = null
            }
            mode = "scroll"
        }
        if (mode === "scroll") {
            const dy = lastY - e.y
            if (dy !== 0) scrollBox.scrollBy(dy)
            lastY = e.y
        }
    }

    scrollBox.onMouseUp = (e: MouseEvent) => {
        if (timer) {
            clearTimeout(timer)
            timer = null
        }
        if (mode === "pending") {
            const moved =
                Math.abs(e.x - downX) > TAP_MOVE_THRESHOLD ||
                Math.abs(e.y - downY) > TAP_MOVE_THRESHOLD
            if (!moved && opts.onTap) opts.onTap(e)
        } else if (mode === "select") {
            if (!armedDragged && opts.renderer) {
                try { opts.renderer.clearSelection() } catch { }
            }
            if (armedTarget) {
                armedTarget.selectable = false
                armedTarget = null
            }
        }
        mode = "idle"
    }
}

/**
 * Attach tap detection to a single renderable (e.g. a list-row Box).
 * Fires `onTap` on a quick down→up with no significant drag. The row's
 * text children should be `selectable: false` so drags aren't swallowed
 * by the renderer's text-selection subsystem.
 */
export function enableTap(target: Renderable, onTap: () => void) {
    let downX = 0
    let downY = 0
    let downTime = 0
    let dragging = false

    target.onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return
        downX = e.x
        downY = e.y
        downTime = Date.now()
        dragging = false
    }
    target.onMouseDrag = (e: MouseEvent) => {
        if (e.button !== 0) return
        if (
            Math.abs(e.x - downX) > TAP_MOVE_THRESHOLD ||
            Math.abs(e.y - downY) > TAP_MOVE_THRESHOLD
        ) {
            dragging = true
        }
    }
    target.onMouseUp = (e: MouseEvent) => {
        if (e.button !== 0) return
        if (dragging) return
        if (Date.now() - downTime > TAP_MAX_MS) return
        onTap()
    }
}

/**
 * Attach tap-to-select-item on a SelectRenderable. Maps the tap's screen
 * y to an item index using the Select's `screenY`, `linesPerItem`, and
 * `scrollOffset`, then calls `setSelectedIndex(i)` + `selectCurrent()`.
 * Works regardless of nesting because it uses screen-absolute coordinates.
 */
export function enableSelectTap(select: SelectRenderable) {
    let downY = 0
    let downTime = 0
    let dragging = false

    select.onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return
        downY = e.y
        downTime = Date.now()
        dragging = false
    }
    select.onMouseDrag = (e: MouseEvent) => {
        if (e.button !== 0) return
        if (Math.abs(e.y - downY) > TAP_MOVE_THRESHOLD) dragging = true
    }
    select.onMouseUp = (e: MouseEvent) => {
        if (e.button !== 0) return
        if (dragging) return
        if (Date.now() - downTime > TAP_MAX_MS) return
        const lp = (select as any).linesPerItem as number
        const so = (select as any).scrollOffset as number
        const sy = (select as any).screenY as number
        if (!lp || lp < 1 || typeof sy !== "number") return
        const relY = e.y - sy
        if (relY < 0) return
        const idx = Math.floor(relY / lp) + (so || 0)
        const opts = select.options
        if (idx < 0 || idx >= opts.length) return
        select.setSelectedIndex(idx)
        select.selectCurrent()
    }
}
