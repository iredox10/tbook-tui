// ─────────────────────────────────────────────────────────────
// Vocabulary Panel — shows all looked-up words with definitions
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    t, bold, fg, italic,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import { getVocabulary, type VocabRecord } from "../services/database"

export class VocabularyPanel {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private listBox!: ScrollBoxRenderable
    private detailBox!: ScrollBoxRenderable
    private visible = false
    private words: VocabRecord[] = []
    private selectedIndex = 0
    private listNodes: TextRenderable[] = []
    private detailNodes: TextRenderable[] = []
    private onClose: () => void
    private inputHandler: ((seq: string) => boolean) | null = null

    constructor(renderer: CliRenderer, onClose: () => void) {
        this.renderer = renderer
        this.onClose = onClose
    }

    show() {
        if (this.visible) return
        this.visible = true
        this.words = getVocabulary()
        this.selectedIndex = 0

        this.container = new BoxRenderable(this.renderer, {
            id: "vocab-overlay",
            position: "absolute",
            top: 2,
            bottom: 2,
            left: "10%",
            right: "10%",
            borderStyle: "rounded",
            borderColor: theme.accent.purple,
            backgroundColor: theme.bg.card,
            flexDirection: "row",
            padding: 1,
            gap: 1,
        })

        // Left panel: word list
        const leftPanel = new BoxRenderable(this.renderer, {
            id: "vocab-left",
            width: "35%",
            height: "100%",
            flexDirection: "column",
            borderStyle: "single",
            borderColor: theme.border.normal,
        })

        leftPanel.add(new TextRenderable(this.renderer, {
            id: "vocab-title",
            content: t` ${bold(fg(theme.accent.purple)(`📖 Vocabulary (${this.words.length})`))}`,
        }))

        this.listBox = new ScrollBoxRenderable(this.renderer, {
            id: "vocab-list",
            width: "100%",
            flexGrow: 1,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: theme.scrollbar.thumb,
                    backgroundColor: theme.scrollbar.track,
                },
            },
            contentOptions: {
                flexDirection: "column",
                gap: 0,
                backgroundColor: theme.bg.card,
            },
        })
        leftPanel.add(this.listBox)
        this.container.add(leftPanel)

        // Right panel: definition detail
        const rightPanel = new BoxRenderable(this.renderer, {
            id: "vocab-right",
            flexGrow: 1,
            height: "100%",
            flexDirection: "column",
            borderStyle: "single",
            borderColor: theme.border.normal,
        })

        rightPanel.add(new TextRenderable(this.renderer, {
            id: "vocab-detail-title",
            content: t` ${bold(fg(theme.accent.cyan)("Definition"))}`,
        }))

        this.detailBox = new ScrollBoxRenderable(this.renderer, {
            id: "vocab-detail",
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
        rightPanel.add(this.detailBox)
        this.container.add(rightPanel)

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "vocab-footer",
            content: t`${fg(theme.text.subtle)(" j/k Navigate · Esc Close")}`,
            position: "absolute",
            bottom: 0,
            left: 1,
        }))

        this.renderer.root.add(this.container)

        this.renderList()
        this.renderDetail()

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
                    if (this.words.length > 0) {
                        this.selectedIndex = (this.selectedIndex + 1) % this.words.length
                        this.renderList()
                        this.renderDetail()
                    }
                    return true
                case "k":
                case "\x1b[A":
                    if (this.words.length > 0) {
                        this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : this.words.length - 1
                        this.renderList()
                        this.renderDetail()
                    }
                    return true
            }
            return true // consume all input
        }
        this.renderer.prependInputHandler(this.inputHandler)
    }

    private renderList() {
        for (const node of this.listNodes) {
            try { this.listBox.remove(node.id) } catch { }
        }
        this.listNodes = []

        if (this.words.length === 0) {
            const empty = new TextRenderable(this.renderer, {
                id: "vocab-empty",
                content: t`\n  ${fg(theme.text.muted)("No words yet. Look up words with D!")}`,
            })
            this.listBox.add(empty)
            this.listNodes.push(empty)
            return
        }

        for (let i = 0; i < this.words.length; i++) {
            const w = this.words[i]!
            const isSelected = i === this.selectedIndex
            const node = new TextRenderable(this.renderer, {
                id: `vocab-item-${i}`,
                content: isSelected
                    ? t` ${fg(theme.accent.amber)("▸")} ${bold(fg(theme.accent.green)(w.word))} ${fg(theme.text.subtle)(`(${w.lookup_count})`)}`
                    : t`   ${fg(theme.text.body)(w.word)} ${fg(theme.text.subtle)(`(${w.lookup_count})`)}`,
            })
            this.listBox.add(node)
            this.listNodes.push(node)
        }
    }

    private renderDetail() {
        for (const node of this.detailNodes) {
            try { this.detailBox.remove(node.id) } catch { }
        }
        this.detailNodes = []

        const word = this.words[this.selectedIndex]
        if (!word) return

        const wordNode = new TextRenderable(this.renderer, {
            id: "vocab-detail-word",
            content: t`\n  ${bold(fg(theme.accent.green)(word.word))}  ${fg(theme.text.subtle)(`looked up ${word.lookup_count}×`)}`,
        })
        this.detailBox.add(wordNode)
        this.detailNodes.push(wordNode)

        const defNode = new TextRenderable(this.renderer, {
            id: "vocab-detail-def",
            content: t`\n${fg(theme.text.body)(word.definition || "No definition stored")}`,
            wrapMode: "word",
        })
        this.detailBox.add(defNode)
        this.detailNodes.push(defNode)
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
