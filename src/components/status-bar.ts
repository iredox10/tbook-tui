// ─────────────────────────────────────────────────────────────
// Status Bar — bottom bar with progress, keybinds, and info
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import { BoxRenderable, TextRenderable, t, bold, fg } from "@opentui/core"
import { theme, progressBar, progressColor } from "../utils/theme"

export interface StatusBarOptions {
    renderer: CliRenderer
    mode?: "library" | "reader" | "stats" | "splash"
}

export class StatusBar {
    public root: BoxRenderable
    private leftText: TextRenderable
    private centerText: TextRenderable
    private rightText: TextRenderable
    private renderer: CliRenderer

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
    }

    setMode(mode: "library" | "reader" | "stats" | "splash") {
        switch (mode) {
            case "splash":
                this.leftText.content = t`${fg(theme.accent.cyan)("TBOOK")} v1.0`
                this.centerText.content = ""
                this.rightText.content = t`${fg(theme.text.subtle)("↑↓ Select · ⏎ Open · q Quit")}`
                break
            case "library":
                this.rightText.content = t`${fg(theme.text.subtle)("↑↓ Navigate · ⏎ Open · / Search · n Import · d Delete · ? Help")}`
                break
            case "reader":
                this.rightText.content = t`${fg(theme.text.subtle)("j/k Scroll · t TOC · / Search · D Dict · E Export · ? Help")}`
                break
            case "stats":
                this.rightText.content = t`${fg(theme.text.subtle)("q Back · ← → Week")}`
                break
        }
    }

    setReaderProgress(chapter: number, totalChapters: number, percent: number) {
        const bar = progressBar(percent, 20)
        const color = progressColor(percent)
        this.leftText.content = t`${fg(color)(bar)} ${fg(theme.text.muted)(`${percent}%`)}`
        this.centerText.content = t`${fg(theme.text.muted)(`Ch ${chapter + 1}/${totalChapters}`)}`
    }

    setLibraryInfo(bookCount: number) {
        this.leftText.content = t`${fg(theme.accent.cyan)("📚")} ${fg(theme.text.muted)(`${bookCount} book${bookCount !== 1 ? "s" : ""}`)}`
        this.centerText.content = ""
    }

    destroy() {
        this.root.destroy()
    }
}
