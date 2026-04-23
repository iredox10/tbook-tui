// ─────────────────────────────────────────────────────────────
// Word Selector — keyboard-driven select mode for picking words
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    t, bold, fg,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import type { StyledParagraph } from "../utils/html-to-text"

export class WordSelector {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private wordArea!: ScrollBoxRenderable
    private infoText!: TextRenderable
    private visible = false
    private paragraphs: StyledParagraph[] = []
    private paraIndex = 0
    private wordIndex = 0
    private currentWords: string[] = []
    private wordNodes: TextRenderable[] = []
    private onWordSelected: (word: string) => void
    private onClose: () => void

    constructor(
        renderer: CliRenderer,
        onWordSelected: (word: string) => void,
        onClose: () => void,
    ) {
        this.renderer = renderer
        this.onWordSelected = onWordSelected
        this.onClose = onClose
    }

    show(paragraphs: StyledParagraph[], startParagraph: number = 0) {
        if (this.visible) return
        this.visible = true
        this.paragraphs = paragraphs.filter(p => p.text.trim().length > 0)
        this.paraIndex = Math.min(startParagraph, this.paragraphs.length - 1)
        this.wordIndex = 0

        // Full-width overlay at bottom half of screen
        this.container = new BoxRenderable(this.renderer, {
            id: "word-sel-root",
            position: "absolute",
            top: 2,
            bottom: 2,
            left: "10%",
            right: "10%",
            borderStyle: "rounded",
            borderColor: theme.accent.amber,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 0,
        })

        // Header
        this.container.add(new TextRenderable(this.renderer, {
            id: "word-sel-title",
            content: t` ${bold(fg(theme.accent.amber)("✎ SELECT MODE"))}  ${fg(theme.text.subtle)("Pick a word")}`,
        }))

        this.container.add(new TextRenderable(this.renderer, {
            id: "word-sel-sep",
            content: " " + "━".repeat(44),
            fg: theme.border.normal,
        }))

        // Info: current paragraph context
        this.infoText = new TextRenderable(this.renderer, {
            id: "word-sel-info",
            content: "",
            wrapMode: "word",
        })
        this.container.add(this.infoText)

        // Scrollable word display area
        this.wordArea = new ScrollBoxRenderable(this.renderer, {
            id: "word-sel-area",
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
                paddingTop: 1,
                flexDirection: "row",
                gap: 0,
                flexWrap: "wrap",
                backgroundColor: theme.bg.card,
            },
        })
        this.container.add(this.wordArea)

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "word-sel-footer",
            content: t`${fg(theme.text.subtle)(" ←→ Word · ↑↓ Paragraph · ⏎ Select · D Dict · Esc Cancel")}`,
        }))

        this.renderer.root.add(this.container)
        this.loadParagraph()

        // Input handler
        this.renderer.addInputHandler((seq: string) => {
            if (!this.visible) return false

            switch (seq) {
                case "\x1b": // Escape
                case "s":   // Toggle off
                    this.hide()
                    return true

                case "h":
                case "\x1b[D": // left
                    this.moveWord(-1)
                    return true

                case "l":
                case "\x1b[C": // right
                    this.moveWord(1)
                    return true

                case "j":
                case "\x1b[B": // down — next paragraph
                    this.moveParagraph(1)
                    return true

                case "k":
                case "\x1b[A": // up — prev paragraph
                    this.moveParagraph(-1)
                    return true

                case " ": // space — move word forward (fast pick)
                    this.moveWord(1)
                    return true

                case "\r":
                case "\n": // enter — select current word
                    this.selectCurrentWord()
                    return true

                case "D":
                case "d": // dictionary directly
                    this.selectCurrentWordForDict()
                    return true
            }
            return true // consume all input in select mode
        })
    }

    private loadParagraph() {
        // Clear previous word nodes
        for (const node of this.wordNodes) {
            try { this.wordArea.remove(node.id) } catch { }
        }
        this.wordNodes = []

        if (this.paragraphs.length === 0) return

        const para = this.paragraphs[this.paraIndex]!
        this.currentWords = para.text.split(/\s+/).filter(w => w.length > 0)
        this.wordIndex = Math.min(this.wordIndex, this.currentWords.length - 1)
        if (this.wordIndex < 0) this.wordIndex = 0

        // Update info header
        const typeLabel = para.type === "heading" ? "📌 Heading" :
            para.type === "quote" ? "💬 Quote" :
                para.type === "list-item" ? "📋 List" : "📄 Paragraph"
        this.infoText.content = t`\n ${fg(theme.accent.cyan)(typeLabel)} ${fg(theme.text.subtle)(`(${this.paraIndex + 1}/${this.paragraphs.length})  ·  ${this.currentWords.length} words`)}\n`

        // Render each word
        for (let i = 0; i < this.currentWords.length; i++) {
            const word = this.currentWords[i]!
            const isSelected = i === this.wordIndex
            const displayWord = word + " "

            const wordNode = new TextRenderable(this.renderer, {
                id: `wsel-w-${i}`,
                content: isSelected
                    ? t`${bold(fg(theme.bg.void)(displayWord))}`
                    : t`${fg(theme.text.body)(displayWord)}`,
                bg: isSelected ? theme.accent.amber : undefined,
            })

            this.wordArea.add(wordNode)
            this.wordNodes.push(wordNode)
        }

        // Try to scroll to make selected word visible
        if (this.currentWords.length > 0) {
            this.wordArea.scrollTo(0)
        }
    }

    private moveWord(delta: number) {
        if (this.currentWords.length === 0) return
        this.wordIndex += delta

        // Wrap around paragraphs
        if (this.wordIndex >= this.currentWords.length) {
            if (this.paraIndex < this.paragraphs.length - 1) {
                this.paraIndex++
                this.wordIndex = 0
                this.loadParagraph()
            } else {
                this.wordIndex = this.currentWords.length - 1
            }
            return
        }
        if (this.wordIndex < 0) {
            if (this.paraIndex > 0) {
                this.paraIndex--
                this.wordIndex = 999 // will be clamped in loadParagraph
                this.loadParagraph()
            } else {
                this.wordIndex = 0
            }
            return
        }

        // Just update highlighting in place
        this.updateHighlight()
    }

    private moveParagraph(delta: number) {
        const newIdx = this.paraIndex + delta
        if (newIdx < 0 || newIdx >= this.paragraphs.length) return
        this.paraIndex = newIdx
        this.wordIndex = 0
        this.loadParagraph()
    }

    private updateHighlight() {
        for (let i = 0; i < this.wordNodes.length; i++) {
            const word = this.currentWords[i]!
            const isSelected = i === this.wordIndex
            const displayWord = word + " "

            this.wordNodes[i]!.content = isSelected
                ? t`${bold(fg(theme.bg.void)(displayWord))}`
                : t`${fg(theme.text.body)(displayWord)}`
            this.wordNodes[i]!.bg = isSelected ? theme.accent.amber : theme.bg.card
        }
    }

    private selectCurrentWord() {
        if (this.currentWords.length === 0) return
        const word = this.currentWords[this.wordIndex]
        if (!word) return
        // Clean the word of punctuation at edges
        const clean = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")
        if (clean) {
            this.onWordSelected(clean)
        }
        this.hide()
    }

    private selectCurrentWordForDict() {
        if (this.currentWords.length === 0) return
        const word = this.currentWords[this.wordIndex]
        if (!word) return
        const clean = word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")
        if (clean) {
            this.onWordSelected(clean)
        }
        this.hide()
    }

    hide() {
        if (!this.visible) return
        this.visible = false
        try { this.renderer.root.remove(this.container.id) } catch { }
        this.onClose()
    }

    destroy() {
        this.hide()
    }
}
