import type { CliRenderer } from "@opentui/core"
import { BoxRenderable, TextRenderable, ScrollBoxRenderable, t, bold, fg } from "@opentui/core"
import { theme } from "../utils/theme"
import { showToast } from "./toast"

export class CodeModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private codeBox!: ScrollBoxRenderable
    private visible = false
    private onClose: () => void
    private inputHandler: ((seq: string) => boolean) | null = null
    private codeText: string = ""

    constructor(renderer: CliRenderer, onClose: () => void) {
        this.renderer = renderer
        this.onClose = onClose
    }

    show(code: string, language?: string) {
        if (this.visible) return
        this.visible = true
        this.codeText = code

        this.container = new BoxRenderable(this.renderer, {
            id: "code-overlay",
            position: "absolute",
            top: 2,
            bottom: 2,
            left: "5%",
            right: "5%",
            borderStyle: "rounded",
            borderColor: theme.accent.blue,
            backgroundColor: theme.bg.void,
            flexDirection: "column",
            padding: 1,
            gap: 0,
        })

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "code-title",
            content: t` ${bold(fg(theme.accent.blue)("💻 Code Focus"))} ${fg(theme.text.muted)(language ? `· ${language}` : "")}`,
        }))

        // Separator
        this.container.add(new TextRenderable(this.renderer, {
            id: "code-sep",
            content: " " + "┄".repeat(40),
            fg: theme.border.normal,
        }))

        // Results area
        this.codeBox = new ScrollBoxRenderable(this.renderer, {
            id: "code-scroll",
            width: "100%",
            flexGrow: 1,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: theme.scrollbar.thumb,
                    backgroundColor: theme.scrollbar.track,
                },
            },
            contentOptions: {
                paddingLeft: 2,
                paddingRight: 2,
                flexDirection: "column",
                backgroundColor: theme.bg.void,
            },
        })
        this.container.add(this.codeBox)

        const textNode = new TextRenderable(this.renderer, {
            id: "code-content",
            content: code ? `\n${code}\n` : "",
            wrapMode: "none",
            fg: theme.text.body,
        })
        this.codeBox.add(textNode)

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "code-footer",
            content: t`${fg(theme.text.subtle)(" j/k up/down · h/l left/right · c Copy · Esc Close")}`,
        }))

        this.renderer.root.add(this.container)
        this.codeBox.focus()

        // Input handler
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false
            if (seq === "\x1b" || seq === "\x1b\x1b" || seq === "q") {
                this.hide()
                return true
            }

            if (seq === "j" || seq === "\x1b[B") {
                this.codeBox.scrollBy(1)
                return true
            }
            if (seq === "k" || seq === "\x1b[A") {
                this.codeBox.scrollBy(-1)
                return true
            }
            if (seq === "l" || seq === "\x1b[C") {
                this.codeBox.scrollBy({ x: 2, y: 0 }, "absolute")
                return true
            }
            if (seq === "h" || seq === "\x1b[D") {
                this.codeBox.scrollBy({ x: -2, y: 0 }, "absolute")
                return true
            }
            if (seq === "c" || seq === "C") {
                try {
                    const success = this.renderer.copyToClipboardOSC52(this.codeText)
                    if (success) showToast(this.renderer, "📋 Code copied to clipboard!", "success")
                    else showToast(this.renderer, "Terminal doesn't support clipboard", "error")
                } catch {
                    showToast(this.renderer, "Clipboard error", "error")
                }
                return true
            }
            return false
        }
        this.renderer.prependInputHandler(this.inputHandler)
    }

    hide() {
        if (!this.visible) return
        this.visible = false
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
