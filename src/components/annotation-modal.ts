// ─────────────────────────────────────────────────────────────
// Annotation Modal — input a note for a highlight
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable,
    InputRenderable, InputRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme } from "../utils/theme"

export class AnnotationModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private input!: InputRenderable
    private visible = false
    private inputHandler: ((seq: string) => boolean) | null = null
    private onSave: (note: string) => void
    private onCancel: () => void

    constructor(
        renderer: CliRenderer,
        onSave: (note: string) => void,
        onCancel: () => void
    ) {
        this.renderer = renderer
        this.onSave = onSave
        this.onCancel = onCancel
    }

    show(defaultText: string = "") {
        if (this.visible) return
        this.visible = true

        this.container = new BoxRenderable(this.renderer, {
            id: "annotation-overlay",
            position: "absolute",
            top: "40%",
            bottom: "40%",
            left: "20%",
            right: "20%",
            borderStyle: "rounded",
            borderColor: theme.accent.blue,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 1,
        })

        this.container.add(new TextRenderable(this.renderer, {
            id: "annotation-title",
            content: t` ${bold(fg(theme.accent.blue)("📝 Add Annotation Note"))}`,
        }))

        this.input = new InputRenderable(this.renderer, {
            id: "annotation-input",
            width: "100%",
            value: defaultText,
            placeholder: "Type your note here...",
            backgroundColor: theme.bg.surface,
            focusedBackgroundColor: theme.bg.hover,
            textColor: theme.text.body,
            cursorColor: theme.accent.blue,
        })

        this.container.add(this.input)

        this.container.add(new TextRenderable(this.renderer, {
            id: "annotation-footer",
            content: t`${fg(theme.text.subtle)(" ⏎ Save · Esc Cancel")}`,
        }))

        this.renderer.root.add(this.container)

        // Never focus the input — manage all input manually so ESC always works
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false

            if (seq === "\x1b" || seq === "\x1b\x1b") {
                this.hide()
                this.onCancel()
                return true
            }

            if (seq === "\r" || seq === "\n") {
                const val = this.input.value.trim()
                this.hide()
                this.onSave(val)
                return true
            }

            // Backspace
            if (seq === "\x7f" || seq === "\b") {
                const val = this.input.value
                if (val.length > 0) {
                    this.input.value = val.slice(0, -1)
                }
                return true
            }

            // Ctrl+U: clear
            if (seq === "\x15") {
                this.input.value = ""
                return true
            }

            // Printable ASCII
            if (seq.length === 1) {
                const ch = seq.charCodeAt(0)
                if (ch >= 32 && ch < 127) {
                    this.input.value += seq
                    return true
                }
            }

            return false
        }

        this.renderer.prependInputHandler(this.inputHandler)
    }

    hide() {
        if (!this.visible) return
        this.visible = false
        this.container.destroy()
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
            this.inputHandler = null
        }
    }

    destroy() {
        this.hide()
    }
}
