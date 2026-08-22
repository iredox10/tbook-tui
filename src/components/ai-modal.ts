import type { CliRenderer } from "@opentui/core"
import { BoxRenderable, TextRenderable, ScrollBoxRenderable, t, bold, italic, fg } from "@opentui/core"
import { theme } from "../utils/theme"
import { askAi } from "../services/ai"
import { enableTouchScroll } from "../utils/touch"

export class AiModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private resultBox!: ScrollBoxRenderable
    private visible = false
    private resultNodes: TextRenderable[] = []
    private onClose: () => void
    private inputHandler: ((seq: string) => boolean) | null = null

    constructor(renderer: CliRenderer, onClose: () => void) {
        this.renderer = renderer
        this.onClose = onClose
    }

    async show(task: "Summarize" | "Explain", contextText: string) {
        if (this.visible) return
        this.visible = true

        this.container = new BoxRenderable(this.renderer, {
            id: "ai-overlay",
            position: "absolute",
            top: 4,
            bottom: 4,
            left: "15%",
            right: "15%",
            borderStyle: "rounded",
            borderColor: theme.accent.purple,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 1,
        })

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "ai-title",
            content: t` ${bold(fg(theme.accent.purple)(`✨ AI Assistant — ${task}`))}`,
        }))

        // Separator
        this.container.add(new TextRenderable(this.renderer, {
            id: "ai-sep",
            content: " " + "┄".repeat(40),
            fg: theme.border.normal,
        }))

        // Results area
        this.resultBox = new ScrollBoxRenderable(this.renderer, {
            id: "ai-results",
            width: "100%",
            flexGrow: 1,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: theme.scrollbar.thumb,
                    backgroundColor: theme.scrollbar.track,
                },
            },
            contentOptions: {
                paddingLeft: 1,
                paddingRight: 1,
                flexDirection: "column",
                gap: 1,
                backgroundColor: theme.bg.card,
            },
        })
        this.container.add(this.resultBox)

        // Touch: drag-to-scroll the AI response.
        enableTouchScroll(this.resultBox, { renderer: this.renderer })

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "ai-footer",
            content: t`${fg(theme.text.subtle)(" j/k Scroll · Esc Close")}`,
        }))

        this.renderer.root.add(this.container)
        this.resultBox.focus()

        // Input handler
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false
            if (seq === "\x1b" || seq === "\x1b\x1b" || seq === "q" || seq === "E") {
                this.hide()
                return true
            }

            if (seq === "j" || seq === "\x1b[B") {
                this.resultBox.scrollBy(1)
                return true
            }
            if (seq === "k" || seq === "\x1b[A") {
                this.resultBox.scrollBy(-1)
                return true
            }
            return false
        }
        this.renderer.prependInputHandler(this.inputHandler)

        await this.runAi(task, contextText)
    }

    private async runAi(task: string, contextText: string) {
        this.clearResults()

        const prompt = task === "Summarize" 
            ? "Please provide a concise summary of the following text chapter."
            : "Please explain the meaning, context, or significance of the following excerpt."

        const loading = new TextRenderable(this.renderer, {
            id: "ai-loading",
            content: t`\n  ${fg(theme.accent.cyan)("⠋")} Thinking...`,
        })
        this.resultBox.add(loading)
        this.resultNodes.push(loading)

        const res = await askAi(prompt, contextText)

        this.clearResults()

        if (res.error) {
            const errNode = new TextRenderable(this.renderer, {
                id: "ai-error",
                content: t`\n  ${fg(theme.accent.pink)("Error:")} ${fg(theme.text.muted)(res.error)}`,
                wrapMode: "word",
            })
            this.resultBox.add(errNode)
            this.resultNodes.push(errNode)
            return
        }

        const paragraphs = res.text.split("\n").filter(p => p.trim() !== "")
        for (let i = 0; i < paragraphs.length; i++) {
            const pNode = new TextRenderable(this.renderer, {
                id: `ai-p-${i}`,
                content: t`\n  ${fg(theme.text.body)(paragraphs[i]!)}`,
                wrapMode: "word",
            })
            this.resultBox.add(pNode)
            this.resultNodes.push(pNode)
        }
    }

    private clearResults() {
        for (const node of this.resultNodes) {
            try { this.resultBox.remove(node.id) } catch { }
        }
        this.resultNodes = []
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
