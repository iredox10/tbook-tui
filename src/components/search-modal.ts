// ─────────────────────────────────────────────────────────────
// Search Modal — search within current book
// ─────────────────────────────────────────────────────────────
// Input is managed manually through the global handler so ESC
// is never consumed by a focused renderable before we see it.
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    InputRenderable, InputRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import { enableTouchScroll, enableTap } from "../utils/touch"
import type { ParsedBook } from "../services/epub-parser"

interface SearchResult {
    chapterIndex: number
    chapterTitle: string
    context: string
    matchIndex: number
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
    private onClose: (lastQuery?: string) => void
    private inputHandler: ((seq: string) => boolean) | null = null
    private inputFocused = true

    constructor(
        renderer: CliRenderer,
        onSelect: (chapterIndex: number) => void,
        onClose: (lastQuery?: string) => void,
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
        this.inputFocused = true

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

        this.container.add(new TextRenderable(this.renderer, {
            id: "search-title",
            content: t` ${bold(fg(theme.accent.amber)("🔍 Search in Book"))}`,
        }))

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

        this.container.add(new TextRenderable(this.renderer, {
            id: "search-results-sep",
            content: " " + "┄".repeat(36),
            fg: theme.border.normal,
        }))

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

        enableTouchScroll(this.resultList, { renderer: this.renderer })

        this.container.add(new TextRenderable(this.renderer, {
            id: "search-footer",
            content: t`${fg(theme.text.subtle)(" ↑↓ Navigate · ⏎ Go to · Esc Close")}`,
        }))

        this.renderer.root.add(this.container)

        // Input handler — prepend so it fires before any focused element
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false

            // ESC: always close
            if (seq === "\x1b" || seq === "\x1b\x1b") {
                this.hide()
                return true
            }

            if (this.inputFocused) {
                // Enter: select first result
                if (seq === "\r" || seq === "\n") {
                    if (this.results.length > 0) {
                        this.selectResult()
                    }
                    return true
                }

                // Backspace
                if (seq === "\x7f" || seq === "\b") {
                    const val = this.input.value
                    if (val.length > 0) {
                        this.input.value = val.slice(0, -1)
                        this.performSearch(this.input.value)
                    }
                    return true
                }

                // Ctrl+U: clear
                if (seq === "\x15") {
                    this.input.value = ""
                    this.performSearch("")
                    return true
                }

                // Tab or j/k/arrows: switch to result navigation
                if (seq === "\t") {
                    this.inputFocused = false
                    this.resultList.focus()
                    return true
                }
                if (seq === "j" || seq === "\x1b[B") {
                    this.inputFocused = false
                    this.resultList.focus()
                    this.moveSelection(1)
                    return true
                }
                if (seq === "k" || seq === "\x1b[A") {
                    this.inputFocused = false
                    this.resultList.focus()
                    this.moveSelection(-1)
                    return true
                }

                // Printable ASCII
                if (seq.length === 1) {
                    const ch = seq.charCodeAt(0)
                    if (ch >= 32 && ch < 127) {
                        this.input.value += seq
                        this.performSearch(this.input.value)
                        return true
                    }
                }

                return true
            } else {
                // Result-focused
                if (seq === "q") {
                    this.hide()
                    return true
                }
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
                // Tab or typing: switch back to input mode
                if (seq === "\t") {
                    this.inputFocused = true
                    return true
                }
                if (seq.length === 1) {
                    const ch = seq.charCodeAt(0)
                    if (ch >= 32 && ch < 127) {
                        this.inputFocused = true
                        this.input.value += seq
                        this.performSearch(this.input.value)
                        return true
                    }
                }
                return true
            }
        }
        this.renderer.prependInputHandler(this.inputHandler)
    }

    private performSearch(query: string) {
        const q = query.toLowerCase().trim()
        this.results = []
        this.selectedIndex = 0

        if (!q || q.length < 2 || !this.book) {
            this.renderResults()
            return
        }

        for (let ci = 0; ci < this.book.chapters.length; ci++) {
            const chapter = this.book.chapters[ci]!
            for (const para of chapter.paragraphs) {
                const lowerText = para.text.toLowerCase()
                const idx = lowerText.indexOf(q)
                if (idx !== -1) {
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
                    if (this.results.length >= 50) break
                }
            }
            if (this.results.length >= 50) break
        }

        this.renderResults()
    }

    private renderResults() {
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

            const idx = i
            enableTap(row, () => {
                this.selectedIndex = idx
                this.selectResult()
            })
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
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
            this.inputHandler = null
        }
        const lastQuery = this.input?.value?.trim() || ""
        try { this.renderer.root.remove(this.container.id) } catch { }
        this.onClose(lastQuery)
    }

    destroy() {
        this.hide()
    }
}
