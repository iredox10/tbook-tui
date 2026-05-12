// ─────────────────────────────────────────────────────────────
// Status Bar — bottom bar with progress, keybinds, and info
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import { BoxRenderable, TextRenderable, t, bold, fg } from "@opentui/core"
import { theme, progressBar, progressColor } from "../utils/theme"

export interface StatusBarOptions {
    renderer: CliRenderer
    mode?: "library" | "reader" | "stats" | "splash" | "select"
}

export class StatusBar {
    public root: BoxRenderable
    private leftText: TextRenderable
    private centerText: TextRenderable
    private rightText: TextRenderable
    private renderer: CliRenderer
    private clockInterval: ReturnType<typeof setInterval> | null = null
    private showClock = true
    private destroyed = false

    constructor(opts: StatusBarOptions) {
        this.renderer = opts.renderer

        this.root = new BoxRenderable(this.renderer, {
            id: "status-bar",
            position: "absolute",
            bottom: 0,
            width: "100%",
            height: 1,
            backgroundColor: theme.bg.surface,
            flexDirection: "row",
            justifyContent: "space-between",
            paddingLeft: 1,
            paddingRight: 1,
        })

        this.leftText = new TextRenderable(this.renderer, {
            id: "status-left",
            content: "",
            fg: theme.text.muted,
        })

        this.centerText = new TextRenderable(this.renderer, {
            id: "status-center",
            content: "",
            fg: theme.text.muted,
        })

        this.rightText = new TextRenderable(this.renderer, {
            id: "status-right",
            content: "",
            fg: theme.text.subtle,
        })

        this.root.add(this.leftText)
        this.root.add(this.centerText)
        this.root.add(this.rightText)

        this.setMode(opts.mode || "library")
        this.startClock()
    }

    private startClock() {
        if (this.destroyed || this.clockInterval) return
        this.clockInterval = setInterval(() => {
            if (this.destroyed || !this.showClock) return
            try {
                const now = new Date()
                const time = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`
                // Only update center if it's currently empty or was a clock before
                const contentStr = typeof this.centerText.content === "string" ? this.centerText.content : this.centerText.content.toString()
                if (!contentStr.includes("Ch") && !contentStr.includes("min")) {
                    this.centerText.content = t`${fg(theme.text.subtle)(time)}`
                }
            } catch {
                // Prevent background clock updates from crashing after teardown races.
                this.destroyed = true
                if (this.clockInterval) {
                    clearInterval(this.clockInterval)
                    this.clockInterval = null
                }
            }
        }, 30000)
    }

    private truncateHints(text: string, maxWidth: number): string {
        const w = this.renderer.width || 80
        const avail = Math.max(20, w - maxWidth)
        if (text.length <= avail) return text
        // Drop least important hints first
        const hints = text.split(" · ")
        let result = hints[0]!
        for (let i = 1; i < hints.length; i++) {
            const next = result + " · " + hints[i]
            if (next.length > avail) break
            result = next
        }
        return result + "…"
    }

    setMode(mode: "library" | "reader" | "stats" | "splash" | "select") {
        if (this.destroyed) return
        switch (mode) {
            case "splash":
                this.leftText.content = t`${fg(theme.accent.cyan)("TBOOK")} v1.0`
                this.centerText.content = ""
                this.rightText.content = this.truncateHints("↑↓ Select · ⏎ Open · q Quit", 20)
                break
            case "library":
                this.rightText.content = this.truncateHints("↑↓ Navigate · ⏎ Open · / Search · n Import · d Delete · ? Help", 25)
                break
            case "reader":
                this.rightText.content = this.truncateHints("j/k Scroll · s Select · t TOC · / Search · D Dict · ? Help", 35)
                break
            case "select":
                this.leftText.content = t`${bold(fg(theme.accent.amber)("✎ SELECT"))}`
                this.rightText.content = this.truncateHints("h/l Char · j/k Line · v Visual · m Mark · D Dict · Esc Exit", 30)
                break
            case "stats":
                this.rightText.content = this.truncateHints("q Back · ← → Week", 25)
                break
        }
    }

    setReaderProgress(chapter: number, totalChapters: number, percent: number, timeInfo?: string, chapterPercent?: number) {
        if (this.destroyed) return
        const bar = progressBar(percent, 20)
        const color = progressColor(percent)
        this.leftText.content = t`${fg(color)(bar)} ${fg(theme.text.muted)(`${percent}%`)}`
        const chPct = typeof chapterPercent === "number" ? ` ▸ ${chapterPercent}%` : ""
        this.centerText.content = t`${fg(theme.text.muted)(`Ch ${chapter + 1}/${totalChapters}${chPct}${timeInfo ? ` · ${timeInfo}` : ''}`)}`
    }

    setLibraryInfo(bookCount: number) {
        if (this.destroyed) return
        this.leftText.content = t`${fg(theme.accent.cyan)("📚")} ${fg(theme.text.muted)(`${bookCount} book${bookCount !== 1 ? "s" : ""}`)}`
    }

    setReadingEstimate(wordsLeft: number) {
        if (this.destroyed) return
        const wpm = 250
        const mins = Math.ceil(wordsLeft / wpm)
        this.centerText.content = t`${fg(theme.text.subtle)(`~${mins} min left`)}`
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        if (this.clockInterval) {
            clearInterval(this.clockInterval)
            this.clockInterval = null
        }
        this.root.destroy()
    }
}
