// ─────────────────────────────────────────────────────────────
// Reader View — the main reading experience
// Phase 2-4: zoom, auto-scroll, stats, theme, PDF, modals,
//            export, dictionary, config, mouse
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    t, bold, italic, fg,
} from "@opentui/core"
import { theme, truncate, progressBar, progressColor, formatDuration, getActiveTheme, setActiveTheme, getTheme } from "../utils/theme"
import { parseEpub, type ParsedBook, type Chapter } from "../services/epub-parser"
import { parsePdf } from "../services/pdf-parser"
import { getBookById, updateReadingProgress, addBookmark, recordReading, type BookRecord } from "../services/database"
import { StatusBar } from "../components/status-bar"
import { showToast } from "../components/toast"
import { HelpOverlay } from "../components/help-overlay"
import { ChapterTocModal } from "../components/chapter-toc"
import { SearchModal } from "../components/search-modal"
import { BookmarksPanel } from "../components/bookmarks-panel"
import { DictionaryModal } from "../components/dictionary-modal"
import { exportBook } from "../services/export"
import { loadConfig, updateConfig } from "../services/config"
import type { App } from "../app"

// Zoom levels: padding on each side of the reading pane
const ZOOM_LEVELS = [1, 2, 4, 6, 8, 12, 16, 20]
const DEFAULT_ZOOM_INDEX = 3 // padding=6

// Auto-scroll speeds in ms per line
const SCROLL_SPEEDS = [
    { ms: 2000, label: "Slow" },
    { ms: 1200, label: "Normal" },
    { ms: 700, label: "Fast" },
    { ms: 400, label: "Rapid" },
]

export class ReaderView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private sidebar!: BoxRenderable
    private readingPane!: ScrollBoxRenderable
    private statusBar!: StatusBar
    private book!: BookRecord
    private parsedBook!: ParsedBook
    private currentChapter = 0
    private sidebarVisible = true
    private chapterTextNodes: TextRenderable[] = []
    private sidebarItems: TextRenderable[] = []

    // Phase 2 state
    private zoomIndex = DEFAULT_ZOOM_INDEX
    private autoScrollInterval: ReturnType<typeof setInterval> | null = null
    private autoScrollSpeedIndex = 1 // "Normal"
    private autoScrollActive = false
    private readStartTime = 0
    private wordsReadThisSession = 0
    private chapterWordCountCache: Map<number, number> = new Map()

    // Phase 3 modals
    private helpOverlay: HelpOverlay | null = null
    private tocModal: ChapterTocModal | null = null
    private searchModal: SearchModal | null = null
    private bookmarksPanel: BookmarksPanel | null = null
    private dictionaryModal: DictionaryModal | null = null
    private modalOpen = false

    constructor(renderer: CliRenderer, app: App) {
        this.renderer = renderer
        this.app = app
    }

    async render(bookId: number) {
        const book = getBookById(bookId)
        if (!book) {
            showToast(this.renderer, "Book not found", "error")
            this.app.showLibrary()
            return
        }

        this.book = book
        this.currentChapter = book.current_chapter
        this.readStartTime = Date.now()

        // Phase 4: Apply saved config preferences
        const config = loadConfig()
        this.zoomIndex = config.defaultZoom
        this.autoScrollSpeedIndex = config.autoScrollSpeed
        this.sidebarVisible = config.sidebarVisible
        if (config.theme !== getActiveTheme()) {
            setActiveTheme(config.theme)
        }
        this.wordsReadThisSession = 0

        // Show loading spinner
        const loading = new TextRenderable(this.renderer, {
            id: "reader-loading",
            content: t`${fg(theme.accent.cyan)("⠋")} Loading ${book.title}...`,
            position: "absolute",
            left: 4,
            top: 2,
        })
        this.renderer.root.add(loading)

        const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        let frame = 0
        const spinnerInterval = setInterval(() => {
            frame = (frame + 1) % frames.length
            loading.content = t`${fg(theme.accent.cyan)(frames[frame]!)} Loading ${book.title}...`
        }, 80)

        try {
            // Choose parser based on format
            if (book.format === "pdf") {
                this.parsedBook = await parsePdf(book.path)
            } else {
                this.parsedBook = await parseEpub(book.path)
            }
        } catch (err) {
            clearInterval(spinnerInterval)
            this.renderer.root.remove(loading.id)
            showToast(this.renderer, `Failed to parse: ${err}`, "error")
            this.app.showLibrary()
            return
        }

        clearInterval(spinnerInterval)
        this.renderer.root.remove(loading.id)

        // Update DB if chapter count changed
        if (book.total_chapters !== this.parsedBook.chapters.length) {
            const { getDb } = await import("../services/database")
            getDb().run("UPDATE books SET total_chapters = ? WHERE id = ?", [
                this.parsedBook.chapters.length,
                book.id,
            ])
        }

        // Cache word counts
        for (let i = 0; i < this.parsedBook.chapters.length; i++) {
            this.chapterWordCountCache.set(i, this.parsedBook.chapters[i]!.wordCount)
        }

        this.buildLayout()
        this.renderChapter()
        this.setupKeybinds()
    }

    // ── Layout ──────────────────────────────────────────────────

    private buildLayout() {
        const th = getTheme()

        this.container = new BoxRenderable(this.renderer, {
            id: "reader-root",
            width: "100%",
            height: "100%",
            flexDirection: "row",
            backgroundColor: th.bg.void,
        })

        // ── Left sidebar: Chapter TOC ──
        this.sidebar = new BoxRenderable(this.renderer, {
            id: "reader-sidebar",
            width: 20,
            height: "100%",
            borderStyle: "rounded",
            borderColor: th.border.normal,
            backgroundColor: th.bg.surface,
            flexDirection: "column",
            paddingTop: 1,
            paddingBottom: 1,
        })

        const sidebarTitle = new TextRenderable(this.renderer, {
            id: "sidebar-title",
            content: t`${bold(fg(th.text.muted)(" CHAPTERS"))}`,
        })
        this.sidebar.add(sidebarTitle)

        const sep = new TextRenderable(this.renderer, {
            id: "sidebar-sep",
            content: " " + "┄".repeat(16),
            fg: th.border.normal,
        })
        this.sidebar.add(sep)

        this.renderSidebarChapters()

        // ── Right: Reading pane ──
        const pad = ZOOM_LEVELS[this.zoomIndex]
        this.readingPane = new ScrollBoxRenderable(this.renderer, {
            id: "reader-pane",
            flexGrow: 1,
            height: "100%",
            borderStyle: "rounded",
            borderColor: th.border.normal,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: th.scrollbar.thumb,
                    backgroundColor: th.scrollbar.track,
                },
            },
            viewportOptions: {
                backgroundColor: th.bg.void,
            },
            contentOptions: {
                paddingLeft: pad,
                paddingRight: pad,
                paddingTop: 2,
                paddingBottom: 4,
                backgroundColor: th.bg.void,
            },
        })

        // ── Status bar ──
        this.statusBar = new StatusBar({ renderer: this.renderer, mode: "reader" })

        this.container.add(this.sidebar)
        this.container.add(this.readingPane)
        this.renderer.root.add(this.container)
        this.renderer.root.add(this.statusBar.root)

        this.readingPane.focus()
    }

    // ── Sidebar ─────────────────────────────────────────────────

    private renderSidebarChapters() {
        const th = getTheme()

        for (const item of this.sidebarItems) {
            try { this.sidebar.remove(item.id) } catch { }
        }
        this.sidebarItems = []

        for (let i = 0; i < this.parsedBook.chapters.length; i++) {
            const ch = this.parsedBook.chapters[i]!
            const isCurrent = i === this.currentChapter
            const num = (i + 1).toString().padStart(2, " ")

            const item = new TextRenderable(this.renderer, {
                id: `sidebar-ch-${i}`,
                content: t` ${isCurrent
                    ? fg(th.accent.blue)("▸")
                    : " "}${fg(isCurrent
                        ? th.accent.blue
                        : th.text.muted)(`${num}. ${truncate(ch.title, 13)}`)}`,
            })

            this.sidebar.add(item)
            this.sidebarItems.push(item)
        }
    }

    // ── Chapter rendering ───────────────────────────────────────

    private renderChapter() {
        const th = getTheme()

        for (const node of this.chapterTextNodes) {
            try { this.readingPane.remove(node.id) } catch { }
        }
        this.chapterTextNodes = []

        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        // Chapter label
        const chapterLabel = new TextRenderable(this.renderer, {
            id: "chapter-label",
            content: t`\n${bold(fg(th.accent.purple)(`Chapter ${this.currentChapter + 1}`))}`,
        })
        this.readingPane.add(chapterLabel)
        this.chapterTextNodes.push(chapterLabel)

        // Chapter title
        const chapterTitle = new TextRenderable(this.renderer, {
            id: "chapter-title",
            content: t`${bold(fg(th.text.bright)(chapter.title))}\n`,
        })
        this.readingPane.add(chapterTitle)
        this.chapterTextNodes.push(chapterTitle)

        // Separator
        const chSep = new TextRenderable(this.renderer, {
            id: "chapter-sep",
            content: "━".repeat(40),
            fg: th.border.normal,
        })
        this.readingPane.add(chSep)
        this.chapterTextNodes.push(chSep)

        // Common text properties for readability
        const textProps = {
            wrapMode: "word" as const,
            selectable: true,
            selectionBg: th.accent.blue,
            selectionFg: th.bg.void,
        }

        // Content paragraphs
        for (let i = 0; i < chapter.paragraphs.length; i++) {
            const p = chapter.paragraphs[i]!
            let node: TextRenderable

            switch (p.type) {
                case "heading":
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: t`\n\n${bold(fg(
                            p.level === 1 ? th.accent.purple :
                                p.level === 2 ? th.accent.blue :
                                    p.level === 3 ? th.accent.cyan :
                                        th.accent.green
                        )(p.text))}\n`,
                    })
                    break

                case "quote":
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: t`\n  ${fg(th.accent.cyan)("│")} ${italic(fg(th.text.muted)(p.text))}\n`,
                    })
                    break

                case "separator":
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        content: `\n${"  ◆  ◆  ◆".padStart(22)}\n`,
                        fg: th.text.subtle,
                    })
                    break

                case "list-item": {
                    const indent = "  ".repeat((p.indent || 0) + 1)
                    let bullet: string
                    if (p.ordered) {
                        bullet = `${p.index}.`
                    } else {
                        // Different bullet styles for nesting depth
                        const bullets = ["•", "◦", "▪", "▸"]
                        bullet = bullets[Math.min(p.indent || 0, bullets.length - 1)]!
                    }
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: t`${indent}${fg(th.accent.cyan)(bullet)} ${fg(th.text.body)(p.text)}`,
                    })
                    break
                }

                case "code":
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: `\n    ${p.text.split("\n").join("\n    ")}\n`,
                        fg: th.accent.green,
                    })
                    break

                default:
                    // Regular paragraph — add proper spacing
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: p.text ? `\n${p.text}\n` : "",
                        fg: th.text.body,
                    })
                    break
            }

            this.readingPane.add(node)
            this.chapterTextNodes.push(node)
        }

        // Scroll to top of new chapter
        this.readingPane.scrollTo(0)

        // Update sidebar highlighting
        this.renderSidebarChapters()

        // Update status bar
        this.updateStatusProgress()

        // Save progress to DB
        updateReadingProgress(this.book.id, this.currentChapter, 0)
    }

    // ── Progress ────────────────────────────────────────────────

    private updateStatusProgress() {
        const percent = this.parsedBook.chapters.length > 0
            ? Math.round(((this.currentChapter + 1) / this.parsedBook.chapters.length) * 100)
            : 0
        this.statusBar.setReaderProgress(
            this.currentChapter,
            this.parsedBook.chapters.length,
            percent,
        )
    }

    // ── Chapter navigation ──────────────────────────────────────

    private navigateChapter(delta: number) {
        const th = getTheme()
        const newChapter = this.currentChapter + delta
        if (newChapter < 0 || newChapter >= this.parsedBook.chapters.length) {
            showToast(
                this.renderer,
                delta > 0 ? "Last chapter" : "First chapter",
                "info",
            )
            return
        }

        // Track words read for the chapter we're leaving
        const leavingWords = this.chapterWordCountCache.get(this.currentChapter) || 0
        this.wordsReadThisSession += leavingWords

        // Flash transition effect
        this.readingPane.viewport.backgroundColor = th.bg.card
        setTimeout(() => {
            this.readingPane.viewport.backgroundColor = th.bg.void
        }, 80)

        this.currentChapter = newChapter
        this.renderChapter()
    }

    // ── Zoom (text width) ───────────────────────────────────────

    private adjustZoom(delta: number) {
        const newIndex = this.zoomIndex + delta
        if (newIndex < 0 || newIndex >= ZOOM_LEVELS.length) {
            showToast(this.renderer, delta > 0 ? "Max zoom" : "Min zoom", "info")
            return
        }
        this.zoomIndex = newIndex
        const pad = ZOOM_LEVELS[this.zoomIndex]

        // Update reading pane padding dynamically
        try {
            this.readingPane.content.paddingLeft = pad
            this.readingPane.content.paddingRight = pad
        } catch {
            // Fallback: direct property access might differ
        }

        const label = pad! <= 2 ? "Compact" : pad! <= 6 ? "Normal" : pad! <= 12 ? "Wide" : "Ultra-wide"
        showToast(this.renderer, `📐 Text width: ${label} (padding ${pad!})`, "info")
    }

    // ── Auto-scroll ─────────────────────────────────────────────

    private toggleAutoScroll() {
        if (this.autoScrollActive) {
            this.stopAutoScroll()
            showToast(this.renderer, "⏸ Auto-scroll paused", "info")
        } else {
            this.startAutoScroll()
            const speed = SCROLL_SPEEDS[this.autoScrollSpeedIndex]
            showToast(this.renderer, `▶ Auto-scroll: ${speed!.label}`, "success")
        }
    }

    private startAutoScroll() {
        this.autoScrollActive = true
        const speed = SCROLL_SPEEDS[this.autoScrollSpeedIndex]
        this.autoScrollInterval = setInterval(() => {
            this.readingPane.scrollBy(1)

            // Auto-advance to next chapter at the end
            const atBottom = this.readingPane.scrollTop >= this.readingPane.scrollHeight - 2
            if (atBottom && this.currentChapter < this.parsedBook.chapters.length - 1) {
                this.navigateChapter(1)
            } else if (atBottom) {
                this.stopAutoScroll()
                showToast(this.renderer, "📖 End of book", "success")
            }
        }, speed!.ms)
    }

    private stopAutoScroll() {
        this.autoScrollActive = false
        if (this.autoScrollInterval) {
            clearInterval(this.autoScrollInterval)
            this.autoScrollInterval = null
        }
    }

    private cycleAutoScrollSpeed() {
        this.autoScrollSpeedIndex = (this.autoScrollSpeedIndex + 1) % SCROLL_SPEEDS.length
        const speed = SCROLL_SPEEDS[this.autoScrollSpeedIndex]

        // Restart with new speed if active
        if (this.autoScrollActive) {
            this.stopAutoScroll()
            this.startAutoScroll()
        }

        showToast(this.renderer, `⚡ Scroll speed: ${speed!.label}`, "info")
    }

    // ── Theme toggle ────────────────────────────────────────────

    private toggleTheme() {
        const current = getActiveTheme()
        const next = current === "dark" ? "light" : "dark"
        setActiveTheme(next)
        const th = getTheme()

        // Update backgrounds
        this.container.backgroundColor = th.bg.void
        this.sidebar.backgroundColor = th.bg.surface
        this.sidebar.borderColor = th.border.normal
        this.readingPane.viewport.backgroundColor = th.bg.void

        try {
            this.readingPane.content.backgroundColor = th.bg.void
        } catch { }

        // Re-render chapter content with new colors
        this.renderChapter()

        // Phase 4: Persist theme to config
        updateConfig("theme", next)

        showToast(this.renderer, `🎨 Theme: ${next === "dark" ? "Dark 🌙" : "Light ☀️"}`, "info")
    }

    // ── Reading stats recording ─────────────────────────────────

    private recordSessionStats() {
        const minutesRead = Math.floor((Date.now() - this.readStartTime) / 60000)
        if (minutesRead < 1 && this.wordsReadThisSession < 100) return

        // Add words for current chapter (partial estimate)
        const currentWords = this.chapterWordCountCache.get(this.currentChapter) || 0
        const totalWords = this.wordsReadThisSession + Math.floor(currentWords * 0.5)

        if (totalWords > 0 || minutesRead > 0) {
            recordReading(this.book.id, totalWords, Math.max(1, minutesRead))
        }
    }

    // ── Keybinds ────────────────────────────────────────────────

    private setupKeybinds() {
        this.renderer.addInputHandler((sequence: string) => {
            // Block all reader input while a modal is open
            if (this.modalOpen) return false

            switch (sequence) {
                // Scrolling
                case "j":
                case "\x1b[B": // down
                    this.readingPane.scrollBy(1)
                    return true
                case "k":
                case "\x1b[A": // up
                    this.readingPane.scrollBy(-1)
                    return true
                case " ": // space — page down
                    this.readingPane.scrollBy(1, "viewport")
                    return true
                case "G": // go to end
                    this.readingPane.scrollTo({ x: 0, y: this.readingPane.scrollHeight })
                    return true
                case "g": // go to top
                    this.readingPane.scrollTo(0)
                    return true

                // Chapter navigation
                case "l":
                case "\x1b[C": // right — next chapter
                    this.navigateChapter(1)
                    return true
                case "h":
                case "\x1b[D": // left — prev chapter
                    this.navigateChapter(-1)
                    return true

                // Zoom
                case "+":
                case "=":
                    this.adjustZoom(1)
                    return true
                case "-":
                case "_":
                    this.adjustZoom(-1)
                    return true

                // Auto-scroll
                case "a":
                    this.toggleAutoScroll()
                    return true
                case "A":
                    this.cycleAutoScrollSpeed()
                    return true

                // Theme
                case "T":
                    this.toggleTheme()
                    return true

                // Bookmark (save)
                case "b":
                    addBookmark(this.book.id, this.currentChapter, this.readingPane.scrollTop, "")
                    showToast(this.renderer, "🔖 Bookmark saved", "success")
                    return true

                // Phase 3: Bookmarks panel
                case "B":
                    this.showBookmarks()
                    return true

                // Phase 3: Chapter TOC
                case "t":
                    this.showToc()
                    return true

                // Phase 3: Search in book
                case "/":
                    this.showSearch()
                    return true

                // Phase 3: Help overlay
                case "?":
                    this.showHelp()
                    return true

                // Phase 4: Dictionary lookup
                case "D":
                    this.showDictionary()
                    return true

                // Phase 4: Export to Obsidian/Logseq
                case "E":
                    this.exportToMarkdown()
                    return true

                // Sidebar toggle
                case "\t":
                    this.sidebarVisible = !this.sidebarVisible
                    this.sidebar.width = this.sidebarVisible ? 20 : 0
                    return true

                // Quit
                case "q":
                    this.recordSessionStats()
                    this.stopAutoScroll()
                    this.app.showLibrary()
                    return true
            }
            return false
        })
    }

    // ── Phase 3 Modal Launchers ──────────────────────────────────

    private showHelp() {
        this.modalOpen = true
        this.helpOverlay = new HelpOverlay(this.renderer, () => {
            this.modalOpen = false
            this.readingPane.focus()
        })
        this.helpOverlay.show()
    }

    private showToc() {
        this.modalOpen = true
        this.tocModal = new ChapterTocModal(
            this.renderer,
            (chapterIndex: number) => {
                this.currentChapter = chapterIndex
                this.renderChapter()
            },
            () => {
                this.modalOpen = false
                this.readingPane.focus()
            },
        )
        this.tocModal.show(this.parsedBook.chapters, this.currentChapter)
    }

    private showSearch() {
        this.modalOpen = true
        this.searchModal = new SearchModal(
            this.renderer,
            (chapterIndex: number) => {
                this.currentChapter = chapterIndex
                this.renderChapter()
            },
            () => {
                this.modalOpen = false
                this.readingPane.focus()
            },
        )
        this.searchModal.show(this.parsedBook)
    }

    private showBookmarks() {
        this.modalOpen = true
        this.bookmarksPanel = new BookmarksPanel(
            this.renderer,
            this.book.id,
            (chapter: number, scrollPos: number) => {
                this.currentChapter = chapter
                this.renderChapter()
                this.readingPane.scrollTo(scrollPos)
            },
            () => {
                this.modalOpen = false
                this.readingPane.focus()
            },
        )
        this.bookmarksPanel.show()
    }

    // ── Phase 4 Features ────────────────────────────────────────

    private showDictionary(word?: string) {
        this.modalOpen = true
        this.dictionaryModal = new DictionaryModal(this.renderer, () => {
            this.modalOpen = false
            this.readingPane.focus()
        })
        this.dictionaryModal.show(word)
    }

    private exportToMarkdown() {
        const config = loadConfig()
        const result = exportBook(this.book, this.parsedBook, {
            format: config.exportFormat,
            outputDir: config.exportDir,
        })

        if (result.success) {
            showToast(this.renderer, `📝 Exported to ${result.path}`, "success")
        } else {
            showToast(this.renderer, `Export failed: ${result.error}`, "error")
        }
    }

    // ── Cleanup ─────────────────────────────────────────────────

    destroy() {
        this.recordSessionStats()
        this.stopAutoScroll()
        this.helpOverlay?.destroy()
        this.tocModal?.destroy()
        this.searchModal?.destroy()
        this.bookmarksPanel?.destroy()
        this.dictionaryModal?.destroy()
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
