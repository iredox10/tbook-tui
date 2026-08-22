// ─────────────────────────────────────────────────────────────
// Touch / pointer helpers for TUI navigation.
//
// Most modern terminals translate touch → mouse events via the SGR
// protocol (touch-drag = mouse drag, tap = click, two-finger = wheel).
// OpenTUI's ScrollBox already handles wheel natively; these helpers add:
//   - enableTouchScroll:  one-finger drag-to-pan (+ optional long-press-select,
//                         swipe, double-tap)
//   - enableTap:          tap-to-activate on a single renderable (list rows)
//   - enableSelectTap:    tap-to-select-item on a SelectRenderable
//   - enableGestures:     tap/double-tap/swipe on any renderable
// All helpers respect the `mouseEnabled` config flag (gated here centrally).
// ─────────────────────────────────────────────────────────────

import type { CliRenderer, MouseEvent, Renderable, ScrollBoxRenderable, SelectRenderable } from "@opentui/core"
import { loadConfig } from "../services/config"

const LONG_PRESS_MS = 350
const TAP_MOVE_THRESHOLD = 4
const TAP_MAX_MS = 600
const SWIPE_MIN_DISTANCE = 15      // columns before a drag counts as a swipe
const SWIPE_DOMINANCE = 1.5        // horizontal must exceed vertical by this ratio
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 8
const SINGLE_TAP_DELAY_MS = 280    // deferred so double-tap can cancel it

// ── Global touch gate (config.mouseEnabled) ─────────────────

let touchOverride: boolean | null = null

/** Force touch on/off at runtime (overrides config until cleared). */
export function setTouchEnabled(enabled: boolean): void {
    touchOverride = enabled
}

/** Drop any runtime override; fall back to config.mouseEnabled. */
export function clearTouchOverride(): void {
    touchOverride = null
}

/** True when touch/pointer gestures should respond (respects config). */
export function isTouchEnabled(): boolean {
    if (touchOverride !== null) return touchOverride
    try {
        return loadConfig().mouseEnabled !== false
    } catch {
        return true
    }
}

export interface TouchScrollOptions {
    renderer?: CliRenderer
    /** Enable long-press → native text selection (reader body only). */
    enableLongPressSelect?: boolean
    /** Called on a tap (down→up, no drag) anywhere on the scroll area.
     *  Deferred ~280ms when onDoubleTap is set, so a second tap can upgrade it. */
    onTap?: (e: MouseEvent) => void
    /** Called when two quick taps land close together. */
    onDoubleTap?: (e: MouseEvent) => void
    /** Called when a horizontal-dominant drag exceeds the swipe threshold. */
    onSwipe?: (dir: "left" | "right") => void
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
    // Double-tap detection
    let tapTimer: ReturnType<typeof setTimeout> | null = null
    let lastTapTime = 0
    let lastTapX = 0
    let lastTapY = 0

    scrollBox.onMouseDown = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
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
        if (!isTouchEnabled()) return
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
        if (!isTouchEnabled()) return
        if (timer) {
            clearTimeout(timer)
            timer = null
        }
        if (mode === "pending") {
            const dx = e.x - downX
            const dy = e.y - downY
            const moved =
                Math.abs(dx) > TAP_MOVE_THRESHOLD ||
                Math.abs(dy) > TAP_MOVE_THRESHOLD
            if (!moved) {
                handleTap(e)
            } else {
                // No drag events arrived (terminal sends press+release only):
                // treat the release delta as a pan, or a horizontal swipe.
                resolveGesture(dx, dy, true)
            }
        } else if (mode === "select") {
            if (!armedDragged && opts.renderer) {
                try { opts.renderer.clearSelection() } catch { }
            }
            if (armedTarget) {
                armedTarget.selectable = false
                armedTarget = null
            }
        } else if (mode === "scroll") {
            // Horizontal-dominant drag past the threshold = chapter swipe.
            // (Vertical panning was already applied live during onMouseDrag.)
            resolveGesture(e.x - downX, e.y - downY, false)
        }
        mode = "idle"
    }

    /** Swipe / pan resolution shared by drag-end and release-only terminals. */
    function resolveGesture(dx: number, dy: number, allowPan: boolean) {
        const adx = Math.abs(dx)
        const ady = Math.abs(dy)
        if (opts.onSwipe && adx >= SWIPE_MIN_DISTANCE && adx > ady * SWIPE_DOMINANCE) {
            opts.onSwipe(dx < 0 ? "left" : "right")
            return
        }
        // Terminals that send only press + release (no motion events during a
        // touch swipe) never reach onMouseDrag — apply the whole delta here.
        if (allowPan && ady >= TAP_MOVE_THRESHOLD) {
            scrollBox.scrollBy(-dy)
        }
    }

    function handleTap(e: MouseEvent) {
        if (!opts.onTap) return
        if (!opts.onDoubleTap) {
            opts.onTap(e)
            return
        }
        // Double-tap detection: defer the single tap briefly so a second
        // tap can upgrade it into a double-tap instead.
        const now = Date.now()
        const near =
            Math.abs(e.x - lastTapX) <= DOUBLE_TAP_PX &&
            Math.abs(e.y - lastTapY) <= DOUBLE_TAP_PX
        if (near && now - lastTapTime <= DOUBLE_TAP_MS) {
            lastTapTime = 0
            if (tapTimer) {
                clearTimeout(tapTimer)
                tapTimer = null
            }
            opts.onDoubleTap(e)
        } else {
            lastTapTime = now
            lastTapX = e.x
            lastTapY = e.y
            if (tapTimer) clearTimeout(tapTimer)
            tapTimer = setTimeout(() => {
                tapTimer = null
                opts.onTap!(e)
            }, SINGLE_TAP_DELAY_MS)
        }
    }
}

// ── Generic gestures (any renderable) ───────────────────────

export interface GestureOptions {
    onTap?: () => void
    onDoubleTap?: () => void
    onSwipe?: (dir: "left" | "right" | "up" | "down") => void
}

/**
 * Attach tap / double-tap / swipe detection to any renderable that isn't a
 * ScrollBox (e.g. the full-screen RSVP overlay). Target's children should be
 * non-interactive so events reach it.
 */
export function enableGestures(target: Renderable, opts: GestureOptions) {
    let downX = 0
    let downY = 0
    let downTime = 0
    let dragging = false
    // Double-tap detection
    let tapTimer: ReturnType<typeof setTimeout> | null = null
    let lastTapTime = 0
    let lastTapX = 0
    let lastTapY = 0

    target.onMouseDown = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
        if (e.button !== 0) return
        downX = e.x
        downY = e.y
        downTime = Date.now()
        dragging = false
    }
    target.onMouseDrag = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
        if (e.button !== 0) return
        if (
            Math.abs(e.x - downX) > TAP_MOVE_THRESHOLD ||
            Math.abs(e.y - downY) > TAP_MOVE_THRESHOLD
        ) {
            dragging = true
        }
    }
    target.onMouseUp = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
        if (e.button !== 0) return
        const elapsed = Date.now() - downTime
        const dx = e.x - downX
        const dy = e.y - downY
        const adx = Math.abs(dx)
        const ady = Math.abs(dy)

        // Swipe from either live drags OR press+release terminals (no motion
        // events during the swipe). Distance is what matters, not dragging.
        if (opts.onSwipe && elapsed <= TAP_MAX_MS * 4 &&
            (adx >= SWIPE_MIN_DISTANCE || ady >= SWIPE_MIN_DISTANCE)) {
            if (adx > ady * SWIPE_DOMINANCE) {
                opts.onSwipe(dx < 0 ? "left" : "right")
                return
            }
            if (ady > adx * SWIPE_DOMINANCE) {
                opts.onSwipe(dy < 0 ? "up" : "down")
                return
            }
        }
        if (dragging) return
        if (elapsed > TAP_MAX_MS) return
        if (!opts.onTap) return
        if (!opts.onDoubleTap) {
            opts.onTap()
            return
        }
        const near =
            Math.abs(e.x - lastTapX) <= DOUBLE_TAP_PX &&
            Math.abs(e.y - lastTapY) <= DOUBLE_TAP_PX
        if (near && Date.now() - lastTapTime <= DOUBLE_TAP_MS) {
            lastTapTime = 0
            if (tapTimer) {
                clearTimeout(tapTimer)
                tapTimer = null
            }
            opts.onDoubleTap()
        } else {
            lastTapTime = Date.now()
            lastTapX = e.x
            lastTapY = e.y
            if (tapTimer) clearTimeout(tapTimer)
            tapTimer = setTimeout(() => {
                tapTimer = null
                opts.onTap!()
            }, SINGLE_TAP_DELAY_MS)
        }
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
        if (!isTouchEnabled()) return
        if (e.button !== 0) return
        downX = e.x
        downY = e.y
        downTime = Date.now()
        dragging = false
    }
    target.onMouseDrag = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
        if (e.button !== 0) return
        if (
            Math.abs(e.x - downX) > TAP_MOVE_THRESHOLD ||
            Math.abs(e.y - downY) > TAP_MOVE_THRESHOLD
        ) {
            dragging = true
        }
    }
    target.onMouseUp = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
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
        if (!isTouchEnabled()) return
        if (e.button !== 0) return
        downY = e.y
        downTime = Date.now()
        dragging = false
    }
    select.onMouseDrag = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
        if (e.button !== 0) return
        if (Math.abs(e.y - downY) > TAP_MOVE_THRESHOLD) dragging = true
    }
    select.onMouseUp = (e: MouseEvent) => {
        if (!isTouchEnabled()) return
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
