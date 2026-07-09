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
import { enableTouchScroll, enableTap } from "../utils/touch"
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
    private inputHandler?: (sequence: string) => boolean

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

        // Touch: drag-to-scroll the list; tap a card to open it.
        enableTouchScroll(this.bookList, { renderer: this.renderer })

        // ── Input handler ──
        this.inputHandler = (sequence: string) => {
            if (this.helpOpen) return false

            if (this.searchMode) {
                if (sequence === "\x1b" || sequence === "\x1b\x1b") {
                    // Escape — exit search
                    this.toggleSearch(false)
                    return true
                }
                if (sequence === "q" && !this.searchInput?.focused) {
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
        }
        this.renderer.addInputHandler(this.inputHandler)

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

        // Deterministic spine color from title hash
        const spineColors = [
            theme.accent.blue, theme.accent.purple, theme.accent.cyan,
            theme.accent.green, theme.accent.pink, theme.accent.amber, theme.accent.orange,
        ]
        const spineColor = spineColors[book.title.length % spineColors.length]!

        const isReading = book.current_chapter > 0 && progress < 100

        const card = new BoxRenderable(this.renderer, {
            id: `book-card-${index}`,
            width: "100%",
            height: 4,
            borderStyle: "rounded",
            borderColor: isSelected ? theme.border.focused : theme.border.normal,
            backgroundColor: isSelected ? theme.bg.hover : theme.bg.card,
            flexDirection: "row",
            paddingLeft: 0,
            paddingRight: 1,
            justifyContent: "flex-start",
            gap: 0,
        })

        // ── Spine block (3x4 colored area) ──
        const spine = new BoxRenderable(this.renderer, {
            id: `book-spine-${index}`,
            width: 3,
            height: "100%",
            backgroundColor: spineColor,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
        })

        const spineIcon = new TextRenderable(this.renderer, {
            id: `book-spine-icon-${index}`,
            content: book.format === "pdf" ? "PDF" : "EPU",
            fg: theme.bg.void,
        })
        spine.add(spineIcon)
        card.add(spine)

        // ── Main content area ──
        const content = new BoxRenderable(this.renderer, {
            id: `book-content-${index}`,
            flexGrow: 1,
            height: "100%",
            flexDirection: "column",
            paddingLeft: 1,
            paddingTop: 0,
            paddingBottom: 0,
            justifyContent: "center",
            gap: 0,
        })

        // Row 1: Title + Author + Badge
        const titleRow = new BoxRenderable(this.renderer, {
            id: `book-title-row-${index}`,
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
            alignItems: "center",
            gap: 1,
        })

        const title = new TextRenderable(this.renderer, {
            id: `book-title-${index}`,
            content: t`${isSelected ? fg(theme.accent.blue)("▸ ") : "  "}${bold(fg(isSelected ? theme.accent.blue : theme.text.bright)(truncate(book.title, 36)))}${isReading ? fg(theme.accent.amber)(" ●") : progress >= 100 ? fg(theme.accent.green)(" ✓") : ""}`,
        })

        const author = new TextRenderable(this.renderer, {
            id: `book-author-${index}`,
            content: truncate(book.author, 18),
            fg: theme.text.muted,
        })

        titleRow.add(title)
        titleRow.add(author)

        // Row 2: Micro progress bar + stats
        const progressRow = new BoxRenderable(this.renderer, {
            id: `book-progress-row-${index}`,
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
            alignItems: "center",
            gap: 1,
        })

        const { microProgressBar } = require("../utils/theme")
        const bar = new TextRenderable(this.renderer, {
            id: `book-progress-${index}`,
            content: t` ${fg(pColor)(microProgressBar(progress, 24))} ${fg(theme.text.muted)(`${progress}%`)}`,
        })

        const lastRead = new TextRenderable(this.renderer, {
            id: `book-lastread-${index}`,
            content: relativeTime(book.last_read_at),
            fg: theme.text.subtle,
        })

        progressRow.add(bar)
        progressRow.add(lastRead)

        content.add(titleRow)
        content.add(progressRow)
        card.add(content)

        // Touch: tap a book card to open it.
        const idx = index
        enableTap(card, () => {
            this.selectedIndex = idx
            this.openSelectedBook()
        })

        return card
    }

    private scrollToSelected() {
        if (this.filteredBooks.length === 0) return

        const cardHeight = 4
        const gap = 1
        const paddingTop = 2

        const cardTop = paddingTop + this.selectedIndex * (cardHeight + gap)
        const cardBottom = cardTop + cardHeight

        const currentScroll = Number(this.bookList.scrollTop || 0)
        const measuredViewport = this.bookList.viewport?.height
        const explicitHeight = this.bookList.height
        const viewportHeight = typeof measuredViewport === "number"
            ? measuredViewport
            : (typeof explicitHeight === "number" ? explicitHeight : 20)

        if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
            this.bookList.scrollTo(Math.max(0, cardTop - 2))
            return
        }

        if (cardTop < currentScroll) {
            this.bookList.scrollTo(cardTop)
        } else if (cardBottom > currentScroll + viewportHeight) {
            this.bookList.scrollTo(Math.max(0, cardBottom - viewportHeight))
        }
    }

    private moveSelection(delta: number) {
        if (this.filteredBooks.length === 0) return
        this.selectedIndex = Math.max(0, Math.min(this.filteredBooks.length - 1, this.selectedIndex + delta))
        this.renderBookCards()
        this.scrollToSelected()
        // Re-apply after layout settles to avoid stale viewport values
        setTimeout(() => this.scrollToSelected(), 0)
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
            this.scrollToSelected()
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
        this.scrollToSelected()
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
        this.scrollToSelected()
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
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
        }
        this.helpOverlay?.destroy()
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
