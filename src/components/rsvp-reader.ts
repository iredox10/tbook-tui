// ─────────────────────────────────────────────────────────────
// RSVP Speed Reader — rapid serial visual presentation
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable,
    t, bold, fg,
} from "@opentui/core"
import { theme } from "../utils/theme"

export class RsvpReader {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private wordDisplay!: TextRenderable
    private infoDisplay!: TextRenderable
    private visible = false
    private words: string[] = []
    private wordIndex = 0
    private wpm = 300
    private running = false
    private timer: ReturnType<typeof setInterval> | null = null
    private onClose: () => void
    private inputHandler: ((seq: string) => boolean) | null = null

    constructor(renderer: CliRenderer, onClose: () => void) {
        this.renderer = renderer
        this.onClose = onClose
    }

    show(paragraphs: { text: string }[]) {
        if (this.visible) return
        this.visible = true

        // Flatten all paragraphs to a word list
        this.words = paragraphs
            .filter(p => p.text)
            .flatMap(p => p.text.split(/\s+/).filter(w => w.length > 0))

        if (this.words.length === 0) {
            this.onClose()
            return
        }

        this.wordIndex = 0
        this.running = false

        this.container = new BoxRenderable(this.renderer, {
            id: "rsvp-overlay",
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: theme.bg.void,
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: 2,
        })

        // Big word display
        this.wordDisplay = new TextRenderable(this.renderer, {
            id: "rsvp-word",
            content: t`${bold(fg(theme.accent.green)(this.words[0] || ""))}`,
        })
        this.container.add(this.wordDisplay)

        // Info bar
        this.infoDisplay = new TextRenderable(this.renderer, {
            id: "rsvp-info",
            content: this.getInfoContent(),
        })
        this.container.add(this.infoDisplay)

        // Help text
        this.container.add(new TextRenderable(this.renderer, {
            id: "rsvp-help",
            content: t`${fg(theme.text.subtle)("Space Pause · +/- Speed · q Quit")}`,
        }))

        this.renderer.root.add(this.container)

        // Input handler
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false
            switch (seq) {
                case "q":
                case "\x1b":
                    this.stop()
                    this.hide()
                    return true
                case " ":
                    if (this.running) {
                        this.stop()
                    } else {
                        this.start()
                    }
                    this.updateInfo()
                    return true
                case "+":
                case "=":
                    this.wpm = Math.min(this.wpm + 50, 1500)
                    if (this.running) { this.stop(); this.start() }
                    this.updateInfo()
                    return true
                case "-":
                case "_":
                    this.wpm = Math.max(this.wpm - 50, 50)
                    if (this.running) { this.stop(); this.start() }
                    this.updateInfo()
                    return true
            }
            return true // consume all input
        }
        this.renderer.prependInputHandler(this.inputHandler)

        // Auto-start
        this.start()
    }

    private start() {
        this.running = true
        const interval = Math.round(60000 / this.wpm)
        this.timer = setInterval(() => {
            this.wordIndex++
            if (this.wordIndex >= this.words.length) {
                this.wordIndex = this.words.length - 1
                this.stop()
                return
            }
            this.updateWord()
        }, interval)
    }

    private stop() {
        this.running = false
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    private updateWord() {
        const word = this.words[this.wordIndex] || ""
        this.wordDisplay.content = t`${bold(fg(theme.accent.green)(word))}`
        this.updateInfo()
    }

    private updateInfo() {
        this.infoDisplay.content = this.getInfoContent()
    }

    private getInfoContent() {
        const progress = Math.round((this.wordIndex / Math.max(this.words.length, 1)) * 100)
        const status = this.running ? "▶" : "⏸"
        return t`${fg(theme.text.muted)(`${status} ${this.wpm} WPM  ·  ${this.wordIndex + 1}/${this.words.length} words  ·  ${progress}%`)}`
    }

    hide() {
        if (!this.visible) return
        this.visible = false
        this.stop()
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
            this.inputHandler = null
        }
        try { this.renderer.root.remove(this.container.id) } catch { }
        this.onClose()
    }

    destroy() {
        this.hide()
    }
}
