// ─────────────────────────────────────────────────────────────
// Annotations Panel — shows all highlights/annotations for current book
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    t, bold, fg, italic,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import { getHighlights, type HighlightRecord } from "../services/database"

export class AnnotationsPanel {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private listBox!: ScrollBoxRenderable
    private visible = false
    private annotations: HighlightRecord[] = []
    private selectedIndex = 0
    private listNodes: TextRenderable[] = []
    private onClose: () => void
    private onJump: (chapter: number, paraIdx: number) => void
    private inputHandler: ((seq: string) => boolean) | null = null

    constructor(
        renderer: CliRenderer,
        onClose: () => void,
        onJump: (chapter: number, paraIdx: number) => void,
    ) {
        this.renderer = renderer
        this.onClose = onClose
        this.onJump = onJump
    }

    show(bookId: number) {
        if (this.visible) return
        this.visible = true
        this.annotations = getHighlights(bookId)
        this.selectedIndex = 0

        this.container = new BoxRenderable(this.renderer, {
            id: "annot-overlay",
            position: "absolute",
            top: 3,
            bottom: 3,
            left: "12%",
            right: "12%",
            borderStyle: "rounded",
            borderColor: theme.accent.amber,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 1,
        })

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "annot-title",
            content: t` ${bold(fg(theme.accent.amber)(`📝 Annotations & Highlights (${this.annotations.length})`))}`,
        }))

        // Separator
        this.container.add(new TextRenderable(this.renderer, {
            id: "annot-sep",
            content: " " + "┄".repeat(50),
            fg: theme.border.normal,
        }))

        // List
        this.listBox = new ScrollBoxRenderable(this.renderer, {
            id: "annot-list",
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
                gap: 0,
                backgroundColor: theme.bg.card,
            },
        })
        this.container.add(this.listBox)

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "annot-footer",
            content: t`${fg(theme.text.subtle)(" j/k Navigate · Enter Jump to · Esc Close")}`,
        }))

        this.renderer.root.add(this.container)
        this.renderList()

        // Input handler
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false
            switch (seq) {
                case "\x1b":
                case "q":
                    this.hide()
                    return true
                case "j":
                case "\x1b[B":
                    if (this.annotations.length > 0) {
                        this.selectedIndex = (this.selectedIndex + 1) % this.annotations.length
                        this.renderList()
                    }
                    return true
                case "k":
                case "\x1b[A":
                    if (this.annotations.length > 0) {
                        this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : this.annotations.length - 1
                        this.renderList()
                    }
                    return true
                case "\r":
                case "\n": {
                    const ann = this.annotations[this.selectedIndex]
                    if (ann) {
                        this.hide()
                        this.onJump(ann.chapter, ann.paragraph_index)
                    }
                    return true
                }
            }
            return true
        }
        this.renderer.prependInputHandler(this.inputHandler)
    }

    private renderList() {
        for (const node of this.listNodes) {
            try { this.listBox.remove(node.id) } catch { }
        }
        this.listNodes = []

        if (this.annotations.length === 0) {
            const empty = new TextRenderable(this.renderer, {
                id: "annot-empty",
                content: t`\n  ${fg(theme.text.muted)("No annotations yet. Use select mode (s) + m to highlight text!")}`,
            })
            this.listBox.add(empty)
            this.listNodes.push(empty)
            return
        }

        for (let i = 0; i < this.annotations.length; i++) {
            const ann = this.annotations[i]!
            const isSelected = i === this.selectedIndex
            const colorIcon = ann.color === "yellow" ? "🟡" : "📌"

            const node = new TextRenderable(this.renderer, {
                id: `annot-item-${i}`,
                content: isSelected
                    ? t`\n ${fg(theme.accent.amber)("▸")} ${colorIcon} ${bold(fg(theme.accent.green)(`Ch ${ann.chapter + 1}`))} ${fg(theme.text.body)(truncate(ann.text, 60))}`
                    : t`\n   ${colorIcon} ${fg(theme.text.subtle)(`Ch ${ann.chapter + 1}`)} ${fg(theme.text.muted)(truncate(ann.text, 60))}`,
            })
            this.listBox.add(node)
            this.listNodes.push(node)

            if (ann.note) {
                const noteNode = new TextRenderable(this.renderer, {
                    id: `annot-note-${i}`,
                    content: t`     ${italic(fg(theme.text.subtle)(`Note: ${truncate(ann.note, 50)}`))}`,
                })
                this.listBox.add(noteNode)
                this.listNodes.push(noteNode)
            }
        }
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
