// ─────────────────────────────────────────────────────────────
// Search Modal — search within current book
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    InputRenderable, InputRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import type { ParsedBook } from "../services/epub-parser"

interface SearchResult {
    chapterIndex: number
    chapterTitle: string
    context: string     // surrounding text
    matchIndex: number  // position in paragraph text
}

export class SearchModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private resultList!: ScrollBoxRenderable
    private input!: InputRenderable
    private visible = false
    private book: ParsedBook | null = null
    private results: SearchResult[] = []
    private selectedIndex = 0
    private resultCards: BoxRenderable[] = []
    private onSelect: (chapterIndex: number) => void
    private onClose: () => void

    constructor(
        renderer: CliRenderer,
        onSelect: (chapterIndex: number) => void,
        onClose: () => void,
    ) {
        this.renderer = renderer
        this.onSelect = onSelect
        this.onClose = onClose
    }

    show(book: ParsedBook) {
        if (this.visible) return
        this.visible = true
        this.book = book
        this.results = []
        this.selectedIndex = 0

        this.container = new BoxRenderable(this.renderer, {
            id: "search-overlay",
            position: "absolute",
            top: 3,
            bottom: 3,
            left: "15%",
            right: "15%",
            borderStyle: "rounded",
            borderColor: theme.accent.amber,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 1,
        })

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "search-title",
            content: t` ${bold(fg(theme.accent.amber)("🔍 Search in Book"))}`,
        }))

        // Input row
        const inputRow = new BoxRenderable(this.renderer, {
            id: "search-input-row",
            width: "100%",
            height: 1,
            flexDirection: "row",
            gap: 1,
            paddingLeft: 1,
        })

        this.input = new InputRenderable(this.renderer, {
            id: "search-input",
            width: 40,
            placeholder: "Type to search...",
            backgroundColor: theme.bg.surface,
            focusedBackgroundColor: theme.bg.hover,
            textColor: theme.text.body,
            cursorColor: theme.accent.amber,
        })

        inputRow.add(this.input)
        this.container.add(inputRow)

        // Separator
        this.container.add(new TextRenderable(this.renderer, {
            id: "search-results-sep",
            content: " " + "┄".repeat(36),
            fg: theme.border.normal,
        }))

        // Results area
        this.resultList = new ScrollBoxRenderable(this.renderer, {
            id: "search-results",
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
        this.container.add(this.resultList)

        // Status
        this.container.add(new TextRenderable(this.renderer, {
            id: "search-footer",
            content: t`${fg(theme.text.subtle)(" ↑↓ Navigate · ⏎ Go to · Esc Close")}`,
        }))

        this.renderer.root.add(this.container)
        this.input.focus()

        // Live search on input
        this.input.on(InputRenderableEvents.INPUT, () => {
            this.performSearch(this.input.value)
        })

        // Input handler
        this.renderer.addInputHandler((seq: string) => {
            if (!this.visible) return false

            if (seq === "\x1b") {
                this.hide()
                return true
            }

            // Navigate results when not focused on input
            if (!this.input.focused) {
                if (seq === "j" || seq === "\x1b[B") {
                    this.moveSelection(1)
                    return true
                }
                if (seq === "k" || seq === "\x1b[A") {
                    this.moveSelection(-1)
                    return true
                }
                if (seq === "\r" || seq === "\n") {
                    this.selectResult()
                    return true
                }
                if (seq === "/") {
                    this.input.focus()
                    return true
                }
            }

            // Tab to switch focus between input and results
            if (seq === "\t") {
                if (this.input.focused) {
                    this.resultList.focus()
                } else {
                    this.input.focus()
                }
                return true
            }

            return false
        })
    }

    private performSearch(query: string) {
        const q = query.toLowerCase().trim()
        this.results = []
        this.selectedIndex = 0

        if (!q || q.length < 2 || !this.book) {
            this.renderResults()
            return
        }

        // Search through all chapters
        for (let ci = 0; ci < this.book.chapters.length; ci++) {
            const chapter = this.book.chapters[ci]!
            for (const para of chapter.paragraphs) {
                const lowerText = para.text.toLowerCase()
                const idx = lowerText.indexOf(q)
                if (idx !== -1) {
                    // Extract surrounding context
                    const start = Math.max(0, idx - 30)
                    const end = Math.min(para.text.length, idx + q.length + 30)
                    let context = para.text.slice(start, end)
                    if (start > 0) context = "…" + context
                    if (end < para.text.length) context = context + "…"

                    this.results.push({
                        chapterIndex: ci,
                        chapterTitle: chapter.title,
                        context,
                        matchIndex: idx,
                    })

                    // Cap results
                    if (this.results.length >= 50) break
                }
            }
            if (this.results.length >= 50) break
        }

        this.renderResults()
    }

    private renderResults() {
        // Clear
        for (const card of this.resultCards) {
            try { this.resultList.remove(card.id) } catch { }
        }
        this.resultCards = []

        if (this.results.length === 0) {
            const query = this.input.value.trim()
            const emptyMsg = new BoxRenderable(this.renderer, {
                id: "search-empty",
                width: "100%",
                height: 2,
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
            })
            emptyMsg.add(new TextRenderable(this.renderer, {
                id: "search-empty-text",
                content: query.length < 2 ? "Type at least 2 characters" : "No results found",
                fg: theme.text.subtle,
            }))
            this.resultList.add(emptyMsg)
            this.resultCards.push(emptyMsg)
            return
        }

        for (let i = 0; i < this.results.length; i++) {
            const r = this.results[i]!
            const isSelected = i === this.selectedIndex

            const row = new BoxRenderable(this.renderer, {
                id: `search-result-${i}`,
                width: "100%",
                height: 2,
                flexDirection: "column",
                paddingLeft: 1,
                backgroundColor: isSelected ? theme.bg.hover : "transparent",
            })

            row.add(new TextRenderable(this.renderer, {
                id: `search-result-ch-${i}`,
                content: t`${isSelected ? fg(theme.accent.amber)("▸ ") : "  "}${fg(theme.accent.blue)(`Ch.${r.chapterIndex + 1}`)} ${fg(theme.text.muted)(truncate(r.chapterTitle, 25))}`,
            }))

            row.add(new TextRenderable(this.renderer, {
                id: `search-result-ctx-${i}`,
                content: t`  ${fg(theme.text.subtle)(truncate(r.context, 50))}`,
            }))

            this.resultList.add(row)
            this.resultCards.push(row)
        }
    }

    private moveSelection(delta: number) {
        if (this.results.length === 0) return
        this.selectedIndex = Math.max(0, Math.min(this.results.length - 1, this.selectedIndex + delta))
        this.renderResults()
    }

    private selectResult() {
        if (this.results.length === 0) return
        const r = this.results[this.selectedIndex]
        if (!r) return
        this.hide()
        this.onSelect(r.chapterIndex)
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
