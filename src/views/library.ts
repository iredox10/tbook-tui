// ─────────────────────────────────────────────────────────────
// Library View — book grid with cards, search, and navigation
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    InputRenderable, InputRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, progressBar, progressColor, truncate, relativeTime } from "../utils/theme"
import { getAllBooks, deleteBook, type BookRecord } from "../services/database"
import { StatusBar } from "../components/status-bar"
import { showToast } from "../components/toast"
import { HelpOverlay } from "../components/help-overlay"
import type { App } from "../app"

export class LibraryView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private bookList!: ScrollBoxRenderable
    private statusBar!: StatusBar
    private books: BookRecord[] = []
    private filteredBooks: BookRecord[] = []
    private selectedIndex = 0
    private searchMode = false
    private searchInput?: InputRenderable
    private cardRenderables: BoxRenderable[] = []
    private helpOverlay: HelpOverlay | null = null
    private helpOpen = false
    constructor(renderer: CliRenderer, app: App) {
        this.renderer = renderer
        this.app = app
    }

    render() {
        this.books = getAllBooks()
        this.filteredBooks = [...this.books]
        this.selectedIndex = 0

        // Root container
        this.container = new BoxRenderable(this.renderer, {
            id: "library-root",
            width: "100%",
            height: "100%",
            flexDirection: "column",
            backgroundColor: theme.bg.void,
        })

        // ── Header ──
        const header = new BoxRenderable(this.renderer, {
            id: "library-header",
            width: "100%",
            height: 3,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingLeft: 2,
            paddingRight: 2,
            backgroundColor: theme.bg.surface,
            borderStyle: "single",
            borderColor: theme.border.normal,
        })

        const titleText = new TextRenderable(this.renderer, {
            id: "library-title",
            content: t`${bold(fg(theme.accent.cyan)("📚 Library"))}`,
        })

        const countText = new TextRenderable(this.renderer, {
            id: "library-count",
            content: t`${fg(theme.text.muted)(`${this.books.length} book${this.books.length !== 1 ? "s" : ""}`)}`,
        })

        header.add(titleText)
        header.add(countText)

        // ── Search bar (hidden by default) ──
        this.searchInput = new InputRenderable(this.renderer, {
            id: "library-search",
            width: 40,
            placeholder: "Search books...",
            backgroundColor: theme.bg.card,
            focusedBackgroundColor: theme.bg.hover,
            textColor: theme.text.body,
            cursorColor: theme.accent.cyan,
        })

        const searchContainer = new BoxRenderable(this.renderer, {
            id: "library-search-container",
            width: "100%",
            height: 0, // Hidden initially
            paddingLeft: 2,
            paddingTop: 0,
            paddingBottom: 0,
            flexDirection: "row",
            gap: 1,
            alignItems: "center",
        })

        const searchIcon = new TextRenderable(this.renderer, {
            id: "library-search-icon",
            content: t`${fg(theme.accent.cyan)("🔍")}`,
        })

        searchContainer.add(searchIcon)
        searchContainer.add(this.searchInput)

        this.searchInput.on(InputRenderableEvents.INPUT, () => {
            this.filterBooks(this.searchInput!.value)
        })

        // ── Book list area ──
        this.bookList = new ScrollBoxRenderable(this.renderer, {
            id: "library-book-list",
            width: "100%",
            flexGrow: 1,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: theme.scrollbar.thumb,
                    backgroundColor: theme.scrollbar.track,
                },
            },
            contentOptions: {
                padding: 2,
                flexDirection: "column",
                gap: 1,
                backgroundColor: theme.bg.void,
            },
        })

        // ── Status bar ──
        this.statusBar = new StatusBar({ renderer: this.renderer, mode: "library" })
        this.statusBar.setLibraryInfo(this.books.length)

        // Assemble
        this.container.add(header)
        this.container.add(searchContainer)
        this.container.add(this.bookList)
        this.renderer.root.add(this.container)
        this.renderer.root.add(this.statusBar.root)

        // Render book cards
        this.renderBookCards()

        // ── Input handler ──
        this.renderer.addInputHandler((sequence: string) => {
            if (this.searchMode) {
                if (sequence === "\x1b" || sequence === "\x1b\x1b") {
                    // Escape — exit search
                    this.toggleSearch(false)
                    return true
                }
                return false // let input handle it
            }

            switch (sequence) {
                case "j":
                case "\x1b[B": // down arrow
                    this.moveSelection(1)
                    return true
                case "k":
                case "\x1b[A": // up arrow
                    this.moveSelection(-1)
                    return true
                case "\r": // enter
                case "\n":
                    this.openSelectedBook()
                    return true
                case "/":
                    this.toggleSearch(true)
                    return true
                case "i":
                    this.app.showStats()
                    return true
                case "n":
                    this.app.showImport()
                    return true
                case "q":
                    this.app.showSplash()
                    return true
                case "d":
                    this.deleteSelectedBook()
                    return true
                case "?":
                    this.showHelp()
                    return true
            }
            return false
        })

        // Focus the list area
        this.bookList.focus()
    }

    private renderBookCards() {
        // Clear existing
        for (const card of this.cardRenderables) {
            try { this.bookList.remove(card.id) } catch { }
        }
        this.cardRenderables = []

        if (this.filteredBooks.length === 0) {
            const empty = new BoxRenderable(this.renderer, {
                id: "library-empty",
                width: "100%",
                height: 5,
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 1,
            })

            const emptyIcon = new TextRenderable(this.renderer, {
                id: "library-empty-icon",
                content: "📭",
            })

            const emptyMsg = new TextRenderable(this.renderer, {
                id: "library-empty-msg",
                content: this.searchMode ? "No books match your search" : "No books yet — press n to import",
                fg: theme.text.muted,
            })

            empty.add(emptyIcon)
            empty.add(emptyMsg)
            this.bookList.add(empty)
            this.cardRenderables.push(empty)
            return
        }

        for (let i = 0; i < this.filteredBooks.length; i++) {
            const book = this.filteredBooks[i]!
            const isSelected = i === this.selectedIndex
            const card = this.createBookCard(book, i, isSelected)
            this.bookList.add(card)
            this.cardRenderables.push(card)
        }
    }

    private createBookCard(book: BookRecord, index: number, isSelected: boolean): BoxRenderable {
        const progress = book.total_chapters > 0
            ? Math.round((book.current_chapter / book.total_chapters) * 100)
            : 0
        const pColor = progressColor(progress)

        const card = new BoxRenderable(this.renderer, {
            id: `book-card-${index}`,
            width: "100%",
            height: 4,
            borderStyle: "rounded",
            borderColor: isSelected ? theme.border.focused : theme.border.normal,
            backgroundColor: isSelected ? theme.bg.hover : theme.bg.card,
            flexDirection: "column",
            paddingLeft: 2,
            paddingRight: 2,
            justifyContent: "center",
            gap: 0,
        })

        // Row 1: Title + Author
        const titleRow = new BoxRenderable(this.renderer, {
            id: `book-title-row-${index}`,
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
        })

        const title = new TextRenderable(this.renderer, {
            id: `book-title-${index}`,
            content: t`${isSelected ? fg(theme.accent.blue)("▸ ") : "  "}${bold(fg(isSelected ? theme.accent.blue : theme.text.bright)(
                truncate(book.title, 40)
            ))}`,
        })

        const author = new TextRenderable(this.renderer, {
            id: `book-author-${index}`,
            content: truncate(book.author, 20),
            fg: theme.text.muted,
        })

        titleRow.add(title)
        titleRow.add(author)

        // Row 2: Progress bar + stats
        const progressRow = new BoxRenderable(this.renderer, {
            id: `book-progress-row-${index}`,
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
        })

        const bar = new TextRenderable(this.renderer, {
            id: `book-progress-${index}`,
            content: t`  ${fg(pColor)(progressBar(progress, 20))} ${fg(theme.text.muted)(`${progress}%`)}`,
        })

        const lastRead = new TextRenderable(this.renderer, {
            id: `book-lastread-${index}`,
            content: relativeTime(book.last_read_at),
            fg: theme.text.subtle,
        })

        progressRow.add(bar)
        progressRow.add(lastRead)

        card.add(titleRow)
        card.add(progressRow)

        return card
    }

    private moveSelection(delta: number) {
        if (this.filteredBooks.length === 0) return
        this.selectedIndex = Math.max(0, Math.min(this.filteredBooks.length - 1, this.selectedIndex + delta))
        this.renderBookCards()
    }

    private openSelectedBook() {
        if (this.filteredBooks.length === 0) return
        const book = this.filteredBooks[this.selectedIndex]
        if (!book) return
        this.app.openReader(book.id)
    }

    private toggleSearch(show: boolean) {
        this.searchMode = show
        // We just focus/unfocus the search input
        if (show) {
            this.searchInput?.focus()
        } else {
            this.searchInput!.value = ""
            this.filteredBooks = [...this.books]
            this.selectedIndex = 0
            this.renderBookCards()
            this.bookList.focus()
        }
    }

    private filterBooks(query: string) {
        const q = query.toLowerCase().trim()
        if (!q) {
            this.filteredBooks = [...this.books]
        } else {
            this.filteredBooks = this.books.filter(
                b => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q),
            )
        }
        this.selectedIndex = 0
        this.renderBookCards()
    }

    private deleteSelectedBook() {
        if (this.filteredBooks.length === 0) return
        const book = this.filteredBooks[this.selectedIndex]
        if (!book) return
        deleteBook(book.id)
        this.books = getAllBooks()
        this.filteredBooks = [...this.books]
        this.selectedIndex = Math.min(this.selectedIndex, this.filteredBooks.length - 1)
        this.renderBookCards()
        this.statusBar.setLibraryInfo(this.books.length)
        showToast(this.renderer, `🗑 Deleted: ${truncate(book.title, 25)}`, "info")
    }

    private showHelp() {
        this.helpOpen = true
        this.helpOverlay = new HelpOverlay(this.renderer, () => {
            this.helpOpen = false
            this.bookList.focus()
        })
        this.helpOverlay.show()
    }

    destroy() {
        this.helpOverlay?.destroy()
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
