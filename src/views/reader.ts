// ─────────────────────────────────────────────────────────────
// Reader View — the main reading experience
// Phase 2-4: zoom, auto-scroll, stats, theme, PDF, modals,
//            export, dictionary, config, mouse
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    CliRenderEvents,
    StyledText, type TextChunk,
    t, bold, italic, fg, bg,
} from "@opentui/core"
import { theme, truncate, progressBar, progressColor, formatDuration, getActiveTheme, setActiveTheme, getTheme, formatInlineRichText } from "../utils/theme"
import { parseEpub, type ParsedBook, type Chapter } from "../services/epub-parser"
import { parsePdf } from "../services/pdf-parser"
import { formatTable } from "../utils/html-to-text"
import { getBookById, updateReadingProgress, addBookmark, recordReading, recordSession, addHighlight, getHighlights, getChapterHighlights, addToVocabulary, type BookRecord, type HighlightRecord } from "../services/database"
import { generateDeepLink, copyDeepLinkToClipboard } from "../services/deep-link"
import { exportAllAnnotations } from "../services/export"
import { StatusBar } from "../components/status-bar"
import { showToast } from "../components/toast"
import { HelpOverlay } from "../components/help-overlay"
import { ChapterTocModal } from "../components/chapter-toc"
import { SearchModal } from "../components/search-modal"
import { AnnotationModal } from "../components/annotation-modal"
import { BookmarksPanel } from "../components/bookmarks-panel"
import { DictionaryModal } from "../components/dictionary-modal"
import { VocabularyPanel } from "../components/vocabulary-panel"
import { AnnotationsPanel } from "../components/annotations-panel"
import { RsvpReader } from "../components/rsvp-reader"
import { AiModal } from "../components/ai-modal"
import { CodeModal } from "../components/code-modal"
import { TTSService } from "../services/tts"
import { renderImageToTerminal, supportsImages } from "../utils/terminal-image"
import { renderParagraph } from "../utils/render-paragraph"
import { exportBook, exportReadingSessionToObsidian } from "../services/export"
import { loadConfig, updateConfig } from "../services/config"
import { posix as pathPosix } from "path"
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
    private sidebar!: ScrollBoxRenderable
    private readingPane!: ScrollBoxRenderable
    private statusBar!: StatusBar
    private book!: BookRecord
    private parsedBook!: ParsedBook
    private currentChapter = 0
    private savedScrollPosition = 0
    private initialChapterLoad = true
    private sidebarVisible = true
    private minimapVisible = false
    private chapterTextNodes: TextRenderable[] = []
    private paraNodes: TextRenderable[] = []
    private sidebarItems: TextRenderable[] = []

    // Phase 2 state
    private zoomIndex = DEFAULT_ZOOM_INDEX
    private autoScrollInterval: ReturnType<typeof setInterval> | null = null
    private autoScrollSpeedIndex = 1 // "Normal"
    private autoScrollActive = false
    private readStartTime = 0
    private startChapter = 0  // chapter index when session started
    private wordsReadThisSession = 0
    private chapterWordCountCache: Map<number, number> = new Map()
    private lineSpacing = 1
    private timerInterval: ReturnType<typeof setInterval> | null = null

    // Phase 3 modals
    private helpOverlay: HelpOverlay | null = null
    private tocModal: ChapterTocModal | null = null
    private searchModal: SearchModal | null = null
    private annotationModal: AnnotationModal | null = null
    private bookmarksPanel: BookmarksPanel | null = null
    private dictionaryModal: DictionaryModal | null = null
    private vocabularyPanel: VocabularyPanel | null = null
    private annotationsPanel: AnnotationsPanel | null = null
    private rsvpReader: RsvpReader | null = null
    private aiModal: AiModal | null = null
    private codeModal: CodeModal | null = null
    private collapsedCodeBlocks = new Set<number>()
    private modalOpen = false
    private lastSelectedText = ""
    private focusMode = false
    private minimapContainer!: BoxRenderable
    private minimapContent!: TextRenderable
    private minimapInterval: Timer | null = null
    private statusBarMounted = false

    private inputHandler?: (sequence: string) => boolean
    private destroyed = false

    // Per-chapter scroll memory (session-level)
    private chapterScrollMemory: Map<number, number> = new Map()
    // Chapter completion tracking
    private completedChapters: Set<number> = new Set()

    // Search-in-chapter state for n/N navigation
    private lastSearchQuery = ""
    private searchMatches: { paraIdx: number; charIdx: number }[] = []
    private searchMatchIndex = -1

    // Multi-color highlight state
    private highlightColor: "yellow" | "green" | "blue" | "pink" = "yellow"

    // Inline select mode / visual mode
    private selectMode = false
    private visualMode = false
    private selectParaIdx = 0
    private selectCharIdx = 0
    private selectionAnchor: { paraIdx: number; charIdx: number } | null = null
    private pendingMotionCount = ""
    // Previous visual selection span (for incremental re-rendering: only
    // restore paragraphs that left the range, instead of rebuilding the whole
    // chapter on every cursor move).
    private lastVisualRange: { sp: number; ep: number } | null = null

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
        this.savedScrollPosition = book.scroll_position || 0
        this.initialChapterLoad = true
        this.readStartTime = Date.now()
        this.startChapter = this.currentChapter

        // Phase 4: Apply saved config preferences
        const config = loadConfig()
        this.zoomIndex = config.defaultZoom
        this.autoScrollSpeedIndex = config.autoScrollSpeed
        this.sidebarVisible = config.sidebarVisible
        this.lineSpacing = config.lineSpacing ?? 1
        if (config.theme !== getActiveTheme()) {
            setActiveTheme(config.theme)
        }
        this.wordsReadThisSession = 0

        if (this.timerInterval) {
            clearInterval(this.timerInterval)
            this.timerInterval = null
        }

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
            } else if (book.format === "md" || book.format === "txt") {
                const { parseMd } = await import("../services/md-parser")
                this.parsedBook = await parseMd(book.path)
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
        this.timerInterval = setInterval(() => {
            this.updateStatusProgress()
        }, 5000)
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
        this.sidebar = new ScrollBoxRenderable(this.renderer, {
            id: "reader-sidebar",
            width: 26,
            height: "100%",
            borderStyle: "rounded",
            borderColor: th.border.normal,
            scrollbarOptions: {
                trackOptions: { foregroundColor: th.bg.surface, backgroundColor: th.bg.surface },
            },
            viewportOptions: { backgroundColor: th.bg.surface },
            contentOptions: {
                flexDirection: "column",
                paddingTop: 1,
                paddingBottom: 1,
                backgroundColor: th.bg.surface,
            },
        })

        const sidebarTitle = new TextRenderable(this.renderer, {
            id: "sidebar-title",
            content: t`${bold(fg(th.text.muted)(" CHAPTERS"))}`,
        })
        this.sidebar.add(sidebarTitle)

        const sep = new TextRenderable(this.renderer, {
            id: "sidebar-sep",
            content: " " + "┄".repeat(22),
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

        // ── Minimap ──
        this.minimapContainer = new BoxRenderable(this.renderer, {
            id: "minimap-container",
            width: 3,
            height: "100%",
            flexDirection: "column",
            backgroundColor: th.bg.void,
            visible: this.minimapVisible,
        })

        this.minimapContent = new TextRenderable(this.renderer, {
            id: "minimap-content",
            content: "",
        })
        this.minimapContainer.add(this.minimapContent)

        // ── Status bar ──
        this.statusBar = new StatusBar({ renderer: this.renderer, mode: "reader" })
        this.statusBarMounted = true

        if (!this.sidebarVisible) this.sidebar.visible = false

        this.container.add(this.sidebar)
        this.container.add(this.readingPane)
        this.container.add(this.minimapContainer)

        this.renderer.root.add(this.container)
        this.renderer.root.add(this.statusBar.root)

        this.readingPane.focus()

        // Phase 4: Listen for text selection events
        this.renderer.on(CliRenderEvents.SELECTION, () => {
            const sel = this.renderer.getSelection()
            if (sel) {
                const text = sel.getSelectedText()?.trim()
                if (text && text.length > 0) {
                    this.lastSelectedText = text
                    // Show hint only for short selections (likely words)
                    if (text.length < 40) {
                        showToast(this.renderer, `Selected: "${text.slice(0, 20)}" — press D for dictionary`, "info")
                    }
                }
            }
        })
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
            const isCompleted = this.completedChapters.has(i)
            const num = (i + 1).toString().padStart(2, " ")

            // Chapter completion marker
            const markerStr = isCurrent ? "▸" : isCompleted ? "✓" : " "
            const markerColor = isCurrent ? th.accent.blue : isCompleted ? th.accent.green : th.text.muted
            const labelColor = isCurrent ? th.accent.blue : isCompleted ? th.accent.green : th.text.muted

            const item = new TextRenderable(this.renderer, {
                id: `sidebar-ch-${i}`,
                content: t` ${fg(markerColor)(markerStr)}${fg(labelColor)(`${num}. ${truncate(ch.title, 19)}`)}`,
            })

            this.sidebar.add(item)
            this.sidebarItems.push(item)
        }

        const visibleHeight = typeof this.sidebar.viewport?.height === "number" ? this.sidebar.viewport.height : 20
        const itemY = 2 + this.currentChapter
        if (itemY < (this.sidebar.scrollTop || 0) || itemY >= (this.sidebar.scrollTop || 0) + visibleHeight) {
            this.sidebar.scrollTo(Math.max(0, itemY - Math.floor(visibleHeight / 2)))
        }
    }

    private formatCodeBlock(code: string, language?: string): string {
        const lines = code.split("\n")
        const lineNumWidth = String(lines.length).length
        const numberedLines = lines.map((line, idx) => {
            const num = String(idx + 1).padStart(lineNumWidth)
            return `  ${num} │ ${line}`
        }).join("\n")

        const label = language && language !== "text" ? ` ${language} ` : ""
        const ruleWidth = Math.max(18, 34 - label.length)
        const topBar = label
            ? `\n  ╭${"─".repeat(2)}${label}${"─".repeat(ruleWidth)}`
            : `\n  ╭${"─".repeat(38)}`
        const botBar = `  ╰${"─".repeat(38)}`

        return `${topBar}\n${numberedLines}\n${botBar}\n`
    }

    // ── Chapter rendering ───────────────────────────────────────

    private renderChapter() {
        const th = getTheme()
        const textProps = {
            wrapMode: "word" as const,
            selectable: true,
            selectionBg: th.accent.blue,
            selectionFg: th.bg.void,
        }

        for (const node of this.chapterTextNodes) {
            try { this.readingPane.remove(node.id) } catch { }
        }
        this.chapterTextNodes = []
        this.paraNodes = []
        this.collapsedCodeBlocks.clear()

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

        // Separator — decorative rule
        const chSep = new TextRenderable(this.renderer, {
            id: "chapter-sep",
            content: t`\n  ${fg(th.text.subtle)("◆  ◆  ◆")}\n`,
        })
        this.readingPane.add(chSep)
        this.chapterTextNodes.push(chSep)

        // Content paragraphs — delegated to renderParagraph utility
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

                case "code": {
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: this.formatCodeBlock(p.text, p.language),
                        fg: th.text.body,
                    })
                    break
                }

                case "table": {
                    const tableText = p.tableRows ? formatTable(p.tableRows) : p.text
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: `\n${tableText}\n`,
                        fg: th.text.body,
                    })
                    break
                }

                case "note": {
                    const icons: Record<string, string> = {
                        tip: "💡", warning: "⚠️", note: "📝", important: "❗",
                    }
                    const colors: Record<string, string> = {
                        tip: th.accent.green, warning: th.accent.amber,
                        note: th.accent.cyan, important: th.accent.pink,
                    }
                    const kind = p.noteKind || "note"
                    const icon = icons[kind] || "📝"
                    const color = colors[kind] || th.accent.cyan
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: t`\n  ${fg(color)("┃")} ${icon} ${bold(fg(color)(kind.toUpperCase()))}\n  ${fg(color)("┃")} ${fg(th.text.body)(p.text)}\n`,
                    })
                    break
                }

                case "footnote": {
                    const ref = p.footnoteRef ? `[${p.footnoteRef}]` : ""
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: t`\n  ${fg(th.accent.cyan)("─")} ${fg(th.text.subtle)(`📎 ${ref}`)} ${italic(fg(th.text.muted)(p.text))}\n`,
                    })
                    break
                }

                case "image": {
                    const src = p.imageSrc || ""
                    const alt = p.imageAlt || p.text || "[Image]"

                    // Try to find the image buffer from the parsed book
                    const imageData = this.resolveImage(src)

                    if (imageData && supportsImages()) {
                        // Render actual image in terminal
                        const terminalImage = renderImageToTerminal(imageData, {
                            width: Math.min(60, (this.readingPane.viewport?.width || 80) - 10),
                        })
                        let imgContent = `\n${terminalImage}\n`
                        if (alt && alt !== "[Image]") {
                            imgContent += `  ↑ ${alt}\n`
                        }
                        node = new TextRenderable(this.renderer, {
                            id: `para-${i}`,
                            ...textProps,
                            content: imgContent,
                        })
                    } else {
                        // Fallback: show styled placeholder
                        const caption = alt !== "[Image]" ? alt : p.text || "Image"
                        node = new TextRenderable(this.renderer, {
                            id: `para-${i}`,
                            ...textProps,
                            content: t`\n  ${fg(th.accent.cyan)("┌─────────────────────────────────┐")}\n  ${fg(th.accent.cyan)("│")}  ${fg(th.text.muted)("🖼️  ")}${fg(th.text.body)(caption.slice(0, 28).padEnd(28))} ${fg(th.accent.cyan)("│")}\n  ${fg(th.accent.cyan)("└─────────────────────────────────┘")}\n`,
                        })
                    }
                    break
                }

                default: {
                    const rich = formatInlineRichText(p.text || "")
                    const nl = (s: string): TextChunk => ({ __isChunk: true, text: s } as TextChunk)
                    node = new TextRenderable(this.renderer, {
                        id: `para-${i}`,
                        ...textProps,
                        content: rich.chunks.length > 0 ? new StyledText([nl("\n"), ...rich.chunks, nl("\n")]) : "",
                        fg: th.text.body,
                    })
                    break
                }
            }

            this.readingPane.add(node)
            this.chapterTextNodes.push(node)
            this.paraNodes.push(node)

            if (this.lineSpacing > 0 && p.type !== "separator") {
                const spc = new TextRenderable(this.renderer, {
                    id: `para-spc-${i}`,
                    content: "\n".repeat(this.lineSpacing),
                })
                this.readingPane.add(spc)
                this.chapterTextNodes.push(spc)
            }
        }

        for (let i = 0; i < chapter.paragraphs.length; i++) {
            this.restoreParagraph(i)
        }

        // Restore saved scroll position on initial chapter load, otherwise scroll to top
        if (this.initialChapterLoad && this.savedScrollPosition > 0) {
            this.initialChapterLoad = false
            // Use a short delay to allow the layout to settle before scrolling
            setTimeout(() => {
                this.readingPane.scrollTo(this.savedScrollPosition)
                // Update status bar and save progress AFTER scroll is restored
                this.updateStatusProgress()
            }, 50)

            // Update sidebar highlighting immediately
            this.renderSidebarChapters()
        } else {
            this.initialChapterLoad = false
            this.readingPane.scrollTo(0)

            // Update sidebar highlighting
            this.renderSidebarChapters()

            // Update status bar
            this.updateStatusProgress()
        }
    }

    // ── Progress ────────────────────────────────────────────────

    private updateStatusProgress() {
        if (this.destroyed || !this.readingPane || !this.parsedBook) return

        const percent = this.parsedBook.chapters.length > 0
            ? Math.round(((this.currentChapter + 1) / this.parsedBook.chapters.length) * 100)
            : 0

        // Calculate chapter scroll percentage
        const scrollHeight = this.readingPane.scrollHeight
        const chapterPercent = scrollHeight > 0
            ? Math.min(100, Math.round((this.readingPane.scrollTop / Math.max(1, scrollHeight - (this.readingPane.viewport?.height || 1))) * 100))
            : 0

        // Track chapter completion
        if (chapterPercent >= 95) {
            this.completedChapters.add(this.currentChapter)
        }

        // Calculate time info
        const minutesElapsed = (Date.now() - this.readStartTime) / 60000
        let timeInfo = ""
        if (minutesElapsed >= 0.5 && this.wordsReadThisSession > 50) {
            const wpm = this.wordsReadThisSession / minutesElapsed
            const totalChapterWords = this.chapterWordCountCache.get(this.currentChapter) || 0
            const progressRatio = scrollHeight > 0 ? (this.readingPane.scrollTop / scrollHeight) : 0
            const wordsLeft = totalChapterWords * (1 - progressRatio)
            const minsLeft = Math.ceil(wordsLeft / wpm)
            timeInfo = `${minsLeft}m left`
        }

        if (this.statusBarMounted) {
            try {
                this.statusBar.setReaderProgress(
                    this.currentChapter,
                    this.parsedBook.chapters.length,
                    percent,
                    timeInfo,
                    chapterPercent
                )
            } catch { }
        }

        // Continuously save scroll position so we can resume later
        this.saveScrollPosition()
    }

    /** Persist current scroll position to the database */
    private saveScrollPosition() {
        if (this.destroyed) return
        if (this.readingPane) {
            updateReadingProgress(this.book.id, this.currentChapter, this.readingPane.scrollTop)
        }
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

        // Save current chapter scroll position to memory
        this.chapterScrollMemory.set(this.currentChapter, this.readingPane.scrollTop)

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

        // Restore saved scroll position for this chapter if we've visited it before
        const savedPos = this.chapterScrollMemory.get(newChapter)
        if (savedPos !== undefined && savedPos > 0) {
            setTimeout(() => {
                this.readingPane.scrollTo(savedPos)
            }, 50)
        }
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

    // ── Line Spacing ────────────────────────────────────────────

    private adjustLineSpacing(delta: number) {
        const next = Math.max(0, Math.min(2, this.lineSpacing + delta))
        if (next === this.lineSpacing) {
            showToast(this.renderer, delta > 0 ? "Max line spacing" : "Min line spacing", "info")
            return
        }
        this.lineSpacing = next
        updateConfig("lineSpacing", next)
        const label = next === 0 ? "Compact" : next === 1 ? "Normal" : "Loose"
        showToast(this.renderer, `↕ Line Spacing: ${label}`, "info")
        this.renderChapter()
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
        const chapterIndex = this.currentChapter
        const scrollTop = this.readingPane.scrollTop
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

        // Re-render chapter content with new colors while preserving viewport position
        this.rerenderCurrentChapterPreserveViewport(chapterIndex, scrollTop)
        if (this.selectMode) {
            setTimeout(() => {
                if (this.currentChapter === chapterIndex && this.selectMode) {
                    this.renderSelection()
                }
            }, 60)
        }

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
            // Record session history for timeline
            recordSession(
                this.book.id,
                this.book.title,
                this.startChapter,
                this.currentChapter,
                totalWords,
                Math.max(1, minutesRead),
            )
        }
    }

    // ── Keybinds ────────────────────────────────────────────────

    private setupKeybinds() {
        const actionMap: Record<string, string> = {
            "scroll_down": "j",
            "scroll_up": "k",
            "page_down": " ",
            "half_page_down": "\x04",
            "half_page_up": "\x15",
            "jump_bottom": "G",
            "jump_top": "g",
            "next_chapter": "l",
            "prev_chapter": "h",
            "zoom_in": "+",
            "zoom_out": "-",
            "toggle_auto_scroll": "a",
            "cycle_auto_scroll": "A",
            "toggle_theme": "T",
            "toggle_minimap": "m",
            "add_bookmark": "b",
            "view_bookmarks": "B",
            "view_annotations": "H",
            "view_toc": "t",
            "search": "/",
            "next_match": "n",
            "prev_match": "N",
            "select_mode": "s",
            "speed_reader": "r",
            "tts": "p",
            "dictionary": "D",
            "ai_summarize": "E",
            "export_chapter": "x",
            "export_all": "X",
            "export_session": "O",
            "deep_link": "L",
            "quit": "q"
        }

        this.inputHandler = (rawSequence: string) => {
            // Block all reader input while a modal is open
            if (this.modalOpen) return false

            let sequence = rawSequence
            const config = loadConfig()
            if (config.customKeybinds) {
                const mappedAction = Object.keys(config.customKeybinds).find(
                    action => config.customKeybinds[action] === rawSequence
                )
                if (mappedAction && actionMap[mappedAction]) {
                    sequence = actionMap[mappedAction]
                }
            }

            // ── SELECT MODE input handling ──
            if (this.selectMode) {
                const isMotionKey = sequence === "j" || sequence === "k" || sequence === "h" || sequence === "l"
                    || sequence === "w" || sequence === "b"
                    || sequence === " "
                    || sequence === "\x1b[A" || sequence === "\x1b[B" || sequence === "\x1b[C" || sequence === "\x1b[D"
                if (/^[0-9]$/.test(sequence)) {
                    if (this.pendingMotionCount.length > 0 || sequence !== "0") {
                        this.pendingMotionCount += sequence
                    }
                    return true
                }

                // Backward-compatible color selection: `1m`/`2m`/... still works.
                if (!isMotionKey && this.pendingMotionCount.length === 1) {
                    switch (this.pendingMotionCount) {
                        case "1":
                            this.highlightColor = "yellow"
                            showToast(this.renderer, "🟡 Highlight color: Yellow", "info")
                            break
                        case "2":
                            this.highlightColor = "green"
                            showToast(this.renderer, "🟢 Highlight color: Green", "info")
                            break
                        case "3":
                            this.highlightColor = "blue"
                            showToast(this.renderer, "🔵 Highlight color: Blue", "info")
                            break
                        case "4":
                            this.highlightColor = "pink"
                            showToast(this.renderer, "🩷 Highlight color: Pink", "info")
                            break
                    }
                }

                switch (sequence) {
                    case "\x1b": // Escape — exit select mode
                    case "s":    // toggle off
                    case "q":    // exit select mode
                        this.pendingMotionCount = ""
                        this.exitSelectMode()
                        return true
                    case "j":
                    case "\x1b[B": // down — next line
                        this.repeatSelectMotion(1, (delta) => this.selectMoveLine(delta))
                        return true
                    case "k":
                    case "\x1b[A": // up — previous line
                        this.repeatSelectMotion(-1, (delta) => this.selectMoveLine(delta))
                        return true
                    case "l":
                    case "\x1b[C": // right — next char
                        this.repeatSelectMotion(1, (delta) => this.selectMoveChar(delta))
                        return true
                    case "h":
                    case "\x1b[D": // left — prev char
                        this.repeatSelectMotion(-1, (delta) => this.selectMoveChar(delta))
                        return true
                    case "w": // advance word
                        this.repeatSelectMotion(1, (delta) => this.selectMoveWord(delta))
                        return true
                    case "b": // prev word
                        this.repeatSelectMotion(-1, (delta) => this.selectMoveWord(delta))
                        return true
                    case " ": // space — advance word
                        this.repeatSelectMotion(1, (delta) => this.selectMoveWord(delta))
                        return true
                    case "\r":
                    case "\n": // enter — confirm selection
                        this.pendingMotionCount = ""
                        this.confirmSelect()
                        return true
                    case "c":
                    case "C": // copy
                        this.pendingMotionCount = ""
                        this.copySelectedOrCode()
                        return true
                    case "-":
                    case "_":
                    case "+":
                    case "=":
                        this.pendingMotionCount = ""
                        this.toggleCodeCollapse()
                        return true
                    case "D":
                    case "d": // dictionary with selected word
                        this.pendingMotionCount = ""
                        this.confirmSelectAndDict()
                        return true
                    case "m": // mark/highlight selected text
                    case "M":
                        this.pendingMotionCount = ""
                        this.highlightSelectedText()
                        return true
                    case "v": // toggle visual selection (set anchor)
                    case "V":
                        this.pendingMotionCount = ""
                        this.toggleVisualMode()
                        return true
                    case "E":
                    case "e": // AI Explain
                        this.pendingMotionCount = ""
                        this.showAiExplain()
                        return true
                    case "p":
                    case "P": // TTS
                        this.pendingMotionCount = ""
                        this.toggleTTS(true)
                        return true

                    case "n": // Add note to highlight
                        this.pendingMotionCount = ""
                        this.highlightWithNote()
                        return true
                }
                this.pendingMotionCount = ""
                return true // consume all other input in select mode
            }

            // ── NORMAL MODE ──
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
                // Half-page scroll (Vim standard)
                case "\x04": // Ctrl+d — half page down
                    this.readingPane.scrollBy(Math.floor((this.readingPane.viewport?.height || 20) / 2))
                    return true
                case "\x15": // Ctrl+u — half page up
                    this.readingPane.scrollBy(-Math.floor((this.readingPane.viewport?.height || 20) / 2))
                    return true
                case "G": // go to end
                    this.readingPane.scrollTo({ x: 0, y: this.readingPane.scrollHeight })
                    return true
                case "g": // go to top
                    this.readingPane.scrollTo(0)
                    return true

                // Search match navigation
                case "n": // next search match
                    this.jumpToNextSearchMatch(1)
                    return true
                case "N": // previous search match
                    this.jumpToNextSearchMatch(-1)
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

                // Line spacing
                case "]":
                    this.adjustLineSpacing(1)
                    return true
                case "[":
                    this.adjustLineSpacing(-1)
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

                // Minimap
                case "m":
                case "M":
                    this.toggleMinimap()
                    return true

                // Bookmark (save)
                case "b":
                    addBookmark(this.book.id, this.currentChapter, this.readingPane.scrollTop, "")
                    showToast(this.renderer, "🔖 Bookmark saved", "success")
                    return true

                // Select mode — inline word picker
                case "s":
                    this.enterSelectMode()
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

                // Phase 4: Dictionary lookup (uses selected text if any)
                case "D": {
                    const sel = this.renderer.getSelection()
                    const selectedWord = sel?.getSelectedText()?.trim() || this.lastSelectedText
                    this.showDictionary(selectedWord || undefined)
                    return true
                }

                // Phase 4: AI Summarize
                case "E":
                    this.showAiSummarize()
                    return true

                // Actually map export to x since E is AI and X is cross-book export
                case "x":
                    this.exportToMarkdown()
                    return true

                // Vocabulary panel
                case "V":
                    this.showVocabulary()
                    return true

                case "p":
                case "P":
                    this.toggleTTS()
                    return true

                // Annotations panel
                case "H":
                    this.showAnnotations()
                    return true

                // RSVP speed reader
                case "r":
                    this.showRsvp()
                    return true

                // Focus mode — hide sidebar + status bar
                case "f":
                    this.toggleFocusMode()
                    return true

                // Sidebar toggle
                case "\t":
                    this.sidebarVisible = !this.sidebarVisible
                    this.sidebar.width = this.sidebarVisible ? 20 : 0
                    return true

                // Deep link — copy paragraph position to clipboard
                case "L":
                    this.copyDeepLink()
                    return true

                // Export all annotations
                case "X":
                    this.exportAllAnnotationsAction()
                    return true

                // Export per-book reading session pack (Obsidian)
                case "O":
                case "o":
                    this.exportSessionToObsidian()
                    return true

                // Quit
                case "q":
                    if (this.timerInterval) clearInterval(this.timerInterval)
                    this.saveScrollPosition()
                    this.recordSessionStats()
                    this.stopAutoScroll()
                    this.app.showLibrary()
                    return true
            }
            return false
        }
        this.renderer.addInputHandler(this.inputHandler)
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
        this.tocModal.show(this.parsedBook.chapters, this.currentChapter, this.completedChapters)
    }

    private showSearch() {
        this.modalOpen = true
        this.searchModal = new SearchModal(
            this.renderer,
            (chapterIndex: number) => {
                this.currentChapter = chapterIndex
                this.renderChapter()
            },
            (lastQuery?: string) => {
                this.modalOpen = false
                this.readingPane.focus()
                // Capture last search query for n/N navigation
                if (lastQuery && lastQuery.length >= 2) {
                    this.lastSearchQuery = lastQuery
                    this.buildSearchMatches(lastQuery)
                }
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
        // Avoid keeping terminal selection highlight while dictionary is open.
        this.renderer.clearSelection()
        this.modalOpen = true
        this.dictionaryModal = new DictionaryModal(this.renderer, () => {
            this.modalOpen = false
            this.renderer.clearSelection()
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

    private exportSessionToObsidian() {
        const config = loadConfig()
        const result = exportReadingSessionToObsidian(this.book, this.parsedBook, {
            outputDir: config.exportDir,
        })

        if (result.success) {
            showToast(
                this.renderer,
                `📦 Session exported (${result.sessions} sessions, ${result.highlights} highlights, ${result.bookmarks} bookmarks) → ${result.path}`,
                "success",
            )
        } else {
            showToast(this.renderer, `Session export failed: ${result.error}`, "error")
        }
    }

    private showVocabulary() {
        this.modalOpen = true
        this.vocabularyPanel = new VocabularyPanel(this.renderer, () => {
            this.modalOpen = false
            this.readingPane.focus()
        })
        this.vocabularyPanel.show()
    }

    private showAnnotations() {
        this.modalOpen = true
        this.annotationsPanel = new AnnotationsPanel(
            this.renderer,
            () => {
                this.modalOpen = false
                this.readingPane.focus()
            },
            (chapter: number, paraIdx: number) => {
                this.modalOpen = false
                this.currentChapter = chapter
                this.renderChapter()
                // Scroll to the paragraph
                const estimatedLine = this.getEstimatedLineOffset(paraIdx)
                this.readingPane.scrollTo(Math.max(0, estimatedLine - 3))
                this.readingPane.focus()
            },
        )
        this.annotationsPanel.show(this.book.id)
    }

    private toggleFocusMode() {
        this.focusMode = !this.focusMode
        if (this.focusMode) {
            this.sidebarVisible = false
            this.sidebar.width = 0
            if (this.statusBarMounted) {
                try { this.statusBar.destroy() } catch { }
                this.statusBarMounted = false
            }
            showToast(this.renderer, "🎯 Focus mode ON — press f to restore", "info")
        } else {
            this.sidebarVisible = true
            this.sidebar.width = 20
            // Recreate status bar (it was destroyed)
            this.statusBar = new StatusBar({ renderer: this.renderer, mode: "reader" })
            this.statusBarMounted = true
            this.statusBar.setMode("reader")
            this.updateStatusProgress()
            showToast(this.renderer, "📖 Focus mode OFF", "info")
        }
    }

    private showRsvp() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter || chapter.paragraphs.length === 0) {
            showToast(this.renderer, "No text to speed-read", "error")
            return
        }
        this.modalOpen = true
        this.rsvpReader = new RsvpReader(this.renderer, () => {
            this.modalOpen = false
            this.readingPane.focus()
        })
        this.rsvpReader.show(chapter.paragraphs)
    }

    private showAiSummarize() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        let text = ""
        for (let i = 0; i < Math.min(chapter.paragraphs.length, 100); i++) {
            text += chapter.paragraphs[i]?.text + "\n\n"
        }

        this.modalOpen = true
        this.aiModal = new AiModal(this.renderer, () => {
            this.modalOpen = false
            this.readingPane.focus()
        })
        this.aiModal.show("Summarize", text.trim())
    }

    private showAiExplain() {
        const selectedText = this.getSelectedText().trim() || this.lastSelectedText
        if (!selectedText) {
            showToast(this.renderer, "No text selected to explain", "error")
            return
        }

        this.modalOpen = true
        this.aiModal = new AiModal(this.renderer, () => {
            this.modalOpen = false
            this.readingPane.focus()
        })
        this.aiModal.show("Explain", selectedText)
        this.exitSelectMode() // Close select mode when opening AI
    }

    // ── Inline Select Mode / Visual Mode ─────────────────────────

    private getEstimatedCharsPerLine(): number {
        const viewportWidth = this.readingPane?.viewport?.width || 80
        const horizontalPad = ZOOM_LEVELS[this.zoomIndex] ?? ZOOM_LEVELS[DEFAULT_ZOOM_INDEX] ?? 6
        // Account for bullets/quotes/indent and some rendering overhead.
        return Math.max(24, viewportWidth - horizontalPad * 2 - 8)
    }

    private getEstimatedParagraphLineSpan(paraIdx: number): number {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        const para = chapter?.paragraphs[paraIdx]
        if (!para) return 1

        const extraSpacing = para.type !== "separator" ? this.lineSpacing : 0

        if (para.type === "code") {
            const fullLines = para.text.split("\n").length
            const visibleLines = this.collapsedCodeBlocks.has(paraIdx)
                ? (fullLines > 2 ? 3 : fullLines)
                : fullLines
            return visibleLines + 2 + extraSpacing
        }

        if (para.type === "table") {
            return (para.tableRows?.length || 0) + 4 + extraSpacing
        }

        if (para.type === "image") {
            return 5 + extraSpacing
        }

        const charsPerLine = this.getEstimatedCharsPerLine()
        const text = para.text || ""
        const wrappedLines = text ? Math.max(1, Math.ceil(text.length / charsPerLine)) : 1
        return wrappedLines + 1 + extraSpacing
    }

    // Helper to accurately estimate line offset for a paragraph
    private getEstimatedLineOffset(targetParaIdx: number): number {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return 0

        let offset = 6 // fixed nodes at top (title, separator, spacing)
        for (let i = 0; i < targetParaIdx; i++) {
            offset += this.getEstimatedParagraphLineSpan(i)
        }
        return offset
    }

    private findNearestSelectableParagraph(startIdx: number): number {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter || chapter.paragraphs.length === 0) return -1

        const clamped = Math.max(0, Math.min(startIdx, chapter.paragraphs.length - 1))
        if (this.getParaText(clamped).trim().length > 0) return clamped

        for (let radius = 1; radius < chapter.paragraphs.length; radius++) {
            const left = clamped - radius
            if (left >= 0 && this.getParaText(left).trim().length > 0) return left
            const right = clamped + radius
            if (right < chapter.paragraphs.length && this.getParaText(right).trim().length > 0) return right
        }

        return -1
    }

    /** Find paragraph nearest a viewport target line (stable in fullscreen/resizes) */
    private getViewportAnchorParagraphIndex(): number {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter || chapter.paragraphs.length === 0) return -1

        const viewportTop = this.readingPane.scrollTop
        const viewportHeight = this.readingPane.viewport?.height || 30
        const targetLine = viewportTop + Math.floor(viewportHeight / 3)

        let bestIdx = -1
        let bestDistance = Number.POSITIVE_INFINITY

        for (let i = 0; i < chapter.paragraphs.length; i++) {
            if (this.getParaText(i).trim().length === 0) continue
            const node = this.paraNodes[i]
            // Prefer real layout coordinates (same convention as the minimap);
            // fall back to the estimate only for nodes not yet laid out. The
            // old code always routed through getParagraphTopLine, whose
            // drifting estimate could anchor the cursor on a paragraph that
            // was actually above the viewport — making the cursor invisible.
            let top: number, span: number
            if (node && typeof node.y === "number" && node.y >= 0 && Number.isFinite(node.y)
                && typeof node.height === "number" && node.height > 0) {
                top = node.y
                span = node.height
            } else {
                top = this.getEstimatedLineOffset(i)
                span = this.getEstimatedParagraphLineSpan(i)
            }
            const bottom = top + span - 1

            if (targetLine >= top && targetLine <= bottom) return i

            const distance = targetLine < top ? (top - targetLine) : (targetLine - bottom)
            if (distance < bestDistance) {
                bestDistance = distance
                bestIdx = i
            }
        }

        return bestIdx
    }

    private enterSelectMode() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter || chapter.paragraphs.length === 0) return

        if (this.autoScrollActive) {
            this.stopAutoScroll()
            showToast(this.renderer, "⏸ Auto-scroll paused for select mode", "info")
        }

        this.selectMode = true
        this.visualMode = false
        this.selectionAnchor = null
        this.pendingMotionCount = ""
        this.lastVisualRange = null
        const viewportAnchor = this.getViewportAnchorParagraphIndex()
        const nearest = this.findNearestSelectableParagraph(viewportAnchor >= 0 ? viewportAnchor : 0)
        if (nearest < 0) {
            this.selectMode = false
            showToast(this.renderer, "No selectable text in this chapter", "info")
            return
        }
        this.selectParaIdx = nearest
        this.selectCharIdx = 0

        if (this.statusBarMounted) {
            try { this.statusBar.setMode("select") } catch { }
        }
        showToast(this.renderer, "✎ SELECT — h/l char · w/b word · j/k line · v visual · c copy · Enter open code · Esc exit", "info")
        try {
            this.renderSelection()
        } catch (err) {
            // Retry once after a clean chapter rerender to recover from stale node refs.
            try {
                const scrollTop = this.readingPane.scrollTop
                this.renderChapter()
                this.readingPane.scrollTo(scrollTop)
                this.renderSelection()
            } catch {
                this.selectMode = false
                this.visualMode = false
                this.selectionAnchor = null
                showToast(this.renderer, `Select mode failed: ${err}`, "error")
            }
        }
    }

    private rerenderCurrentChapterPreserveViewport(chapterIndex: number, scrollTop: number) {
        this.currentChapter = chapterIndex
        this.renderChapter()
        setTimeout(() => {
            if (this.currentChapter === chapterIndex) {
                this.readingPane.scrollTo(scrollTop)
                this.updateStatusProgress()
            }
        }, 50)
    }

    private exitSelectMode() {
        if (!this.selectMode) return
        this.clearAllSelectionHighlights()
        this.selectMode = false
        this.visualMode = false
        this.selectionAnchor = null
        this.pendingMotionCount = ""
        this.lastVisualRange = null
        if (this.statusBarMounted) {
            try { this.statusBar.setMode("reader") } catch { }
        }
    }

    private consumeMotionCount(): number {
        const count = this.pendingMotionCount ? parseInt(this.pendingMotionCount, 10) : 1
        this.pendingMotionCount = ""
        if (!Number.isFinite(count) || count <= 0) return 1
        return Math.min(count, 200)
    }

    private repeatSelectMotion(delta: number, move: (delta: number) => void) {
        const count = this.consumeMotionCount()
        for (let i = 0; i < count; i++) move(delta)
    }

    private toggleVisualMode() {
        if (this.visualMode) {
            this.clearAllSelectionHighlights()
            this.visualMode = false
            this.selectionAnchor = null
            this.lastVisualRange = null
            showToast(this.renderer, "✎ Visual off — single char cursor", "info")
        } else {
            this.visualMode = true
            this.selectionAnchor = { paraIdx: this.selectParaIdx, charIdx: this.selectCharIdx }
            this.lastVisualRange = null
            showToast(this.renderer, "✎ VISUAL — move to extend selection · m mark · d dict · Esc cancel", "info")
        }
        this.renderSelection()
    }

    private getParaText(paraIdx: number): string {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return ""
        const para = chapter.paragraphs[paraIdx]
        return para?.text || ""
    }

    /** Get ordered selection range */
    private getSelectionRange(): { sp: number; sc: number; ep: number; ec: number } {
        if (!this.visualMode || !this.selectionAnchor) {
            const text = this.getParaText(this.selectParaIdx)
            let sc = this.selectCharIdx
            let ec = this.selectCharIdx
            if (text && /[^\s]/.test(text[this.selectCharIdx] || "")) {
                // Expand to word boundaries (non-whitespace)
                while (sc > 0 && /[^\s]/.test(text[sc - 1] || "")) sc--
                while (ec < text.length - 1 && /[^\s]/.test(text[ec + 1] || "")) ec++
            }
            return { sp: this.selectParaIdx, sc, ep: this.selectParaIdx, ec }
        }
        const a = this.selectionAnchor
        const c = { paraIdx: this.selectParaIdx, charIdx: this.selectCharIdx }
        if (a.paraIdx < c.paraIdx || (a.paraIdx === c.paraIdx && a.charIdx <= c.charIdx)) {
            return { sp: a.paraIdx, sc: a.charIdx, ep: c.paraIdx, ec: c.charIdx }
        }
        return { sp: c.paraIdx, sc: c.charIdx, ep: a.paraIdx, ec: a.charIdx }
    }

    /** Extract text from the current selection range */
    private getSelectedText(): string {
        const { sp, sc, ep, ec } = this.getSelectionRange()
        const result: string[] = []
        for (let pi = sp; pi <= ep; pi++) {
            const text = this.getParaText(pi)
            const cStart = (pi === sp) ? sc : 0
            const cEnd = (pi === ep) ? ec : text.length - 1
            if (cStart <= cEnd) {
                result.push(text.slice(cStart, cEnd + 1))
            }
        }
        return result.join("\n")
    }

    private selectMoveChar(delta: number) {
        const text = this.getParaText(this.selectParaIdx)
        let newIdx = this.selectCharIdx + delta

        if (newIdx >= text.length) {
            this.selectMoveParagraph(1, true)
            return
        }
        if (newIdx < 0) {
            this.selectMoveParagraph(-1, true)
            return
        }

        this.selectCharIdx = newIdx
        this.renderSelection()
    }

    private selectMoveWord(delta: number) {
        const text = this.getParaText(this.selectParaIdx)
        if (text.length === 0) return this.selectMoveParagraph(delta, true)

        let i = this.selectCharIdx
        if (delta > 0) {
            while (i < text.length && /\S/.test(text[i] || "")) i++
            while (i < text.length && /\s/.test(text[i] || "")) i++
            if (i >= text.length) return this.selectMoveParagraph(1, true)
        } else {
            i--
            while (i >= 0 && /\s/.test(text[i] || "")) i--
            while (i >= 0 && /\S/.test(text[i] || "")) i--
            i++ // Start of word
            if (i < 0) return this.selectMoveParagraph(-1, true)
        }
        this.selectCharIdx = Math.max(0, Math.min(i, text.length - 1))
        this.renderSelection()
    }

    private getNextSelectableParagraph(fromIdx: number, delta: number): number {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter || delta === 0) return -1
        for (let i = fromIdx + delta; i >= 0 && i < chapter.paragraphs.length; i += delta) {
            if (this.getParaText(i).trim().length > 0) return i
        }
        return -1
    }

    private selectMoveLine(delta: number) {
        const text = this.getParaText(this.selectParaIdx)
        if (!text) return this.selectMoveParagraph(delta, true)

        const charsPerLine = this.getEstimatedCharsPerLine()
        const currentLine = Math.floor(this.selectCharIdx / charsPerLine)
        const preferredCol = this.selectCharIdx % charsPerLine
        const targetLine = currentLine + delta

        if (targetLine >= 0 && targetLine * charsPerLine < text.length) {
            this.selectCharIdx = Math.min(targetLine * charsPerLine + preferredCol, text.length - 1)
            this.renderSelection()
            return
        }

        const nextParaIdx = this.getNextSelectableParagraph(this.selectParaIdx, delta > 0 ? 1 : -1)
        if (nextParaIdx < 0) return

        if (!this.visualMode) this.restoreParagraph(this.selectParaIdx)
        this.selectParaIdx = nextParaIdx
        const nextText = this.getParaText(nextParaIdx)
        if (!nextText) return

        if (delta > 0) {
            this.selectCharIdx = Math.min(preferredCol, Math.max(0, nextText.length - 1))
        } else {
            const lastLine = Math.max(0, Math.floor((nextText.length - 1) / charsPerLine))
            this.selectCharIdx = Math.min(lastLine * charsPerLine + preferredCol, nextText.length - 1)
        }
        this.renderSelection()
    }

    private selectMoveParagraph(delta: number, jumpToEnd = false) {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        let newIdx = this.selectParaIdx + delta
        while (newIdx >= 0 && newIdx < chapter.paragraphs.length && this.getParaText(newIdx).trim().length === 0) {
            newIdx += delta
        }
        if (newIdx < 0 || newIdx >= chapter.paragraphs.length) return

        if (!this.visualMode) this.restoreParagraph(this.selectParaIdx)
        this.selectParaIdx = newIdx
        const nextText = this.getParaText(newIdx)
        if (jumpToEnd) {
            if (delta < 0) {
                this.selectCharIdx = Math.max(0, nextText.length - 1)
            } else {
                this.selectCharIdx = 0
            }
        } else {
            this.selectCharIdx = Math.max(0, Math.min(this.selectCharIdx, Math.max(0, nextText.length - 1)))
        }
        this.renderSelection()
    }

    /** Render the current selection highlight */
    private renderSelection() {
        const th = getTheme()
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        if (this.visualMode && this.selectionAnchor) {
            // Visual mode: highlight full range between anchor and cursor.
            // Incremental re-render: only restore paragraphs that just left the
            // previous selection span, instead of rebuilding the whole chapter
            // (and re-querying highlights for every paragraph) on each move.
            const { sp, sc, ep, ec } = this.getSelectionRange()
            const liveColor = this.getHighlightBgColor(this.highlightColor, th)

            if (this.lastVisualRange) {
                const lo = Math.min(this.lastVisualRange.sp, this.lastVisualRange.ep)
                const hi = Math.max(this.lastVisualRange.sp, this.lastVisualRange.ep)
                for (let i = lo; i <= hi; i++) {
                    if (i < sp || i > ep) this.restoreParagraph(i)
                }
            }

            for (let pi = sp; pi <= ep; pi++) {
                const text = this.getParaText(pi)
                if (text.length === 0) continue
                const para = chapter.paragraphs[pi]
                if (!para) continue

                const node = this.paraNodes[pi]
                if (!node) continue

                const cStart = (pi === sp) ? sc : 0
                const cEnd = (pi === ep) ? ec : text.length - 1

                const prefix = text.slice(0, cStart)
                const highlighted = text.slice(cStart, cEnd + 1)
                const suffix = text.slice(cEnd + 1)

                this.applyHighlightToNode(node, para, th, prefix, highlighted, suffix, liveColor)
            }
            this.lastVisualRange = { sp, ep }
        } else {
            // Select mode: single char cursor
            const text = this.getParaText(this.selectParaIdx)
            if (text.length === 0) return
            this.selectCharIdx = Math.max(0, Math.min(this.selectCharIdx, text.length - 1))

            const para = chapter.paragraphs[this.selectParaIdx]
            if (!para) return
            const node = this.paraNodes[this.selectParaIdx]
            if (!node) return

            const prefix = text.slice(0, this.selectCharIdx)
            const highlighted = text[this.selectCharIdx] || " "
            const suffix = text.slice(this.selectCharIdx + 1)
            const liveColor = this.getHighlightBgColor(this.highlightColor, th)

            this.applyHighlightToNode(node, para, th, prefix, highlighted, suffix, liveColor)
        }

        // Keep the cursor's line on-screen. Uses real layout coordinates
        // (node.y / node.height vs scrollTop) in the same convention as the
        // minimap — NOT the old hand-rolled line estimates, which ignored
        // word-wrap slack and cumulatively drifted below the real node.y.
        // That drift made getParagraphTopLine flip-flop between the estimate
        // and the real y, so scrollTo() jumped up then back down on every
        // keypress — scrolling the cursor off-screen (invisible) and causing
        // the up/down flicker. Minimal-scroll (no re-centering) + a no-op when
        // the cursor is already visible keeps movement stable.
        const node = this.paraNodes[this.selectParaIdx]
        if (node && typeof node.y === "number" && node.y >= 0 && Number.isFinite(node.y)
            && typeof node.height === "number" && node.height > 0) {
            const viewportTop = this.readingPane.scrollTop
            const viewportHeight = this.readingPane.viewport?.height || 30
            const viewportBottom = viewportTop + viewportHeight
            // Approximate the cursor's line within its paragraph. This local
            // estimate does NOT accumulate across paragraphs, so any error stays
            // bounded to a few lines — far safer than the old cumulative drift.
            const charsPerLine = Math.max(1, this.getEstimatedCharsPerLine())
            const cursorLineInPara = Math.floor(this.selectCharIdx / charsPerLine)
            const cursorY = node.y + cursorLineInPara
            if (cursorY < viewportTop + 1) {
                this.readingPane.scrollTo(Math.max(0, cursorY))
            } else if (cursorY > viewportBottom - 2) {
                this.readingPane.scrollTo(Math.max(0, cursorY - viewportHeight + 2))
            }
        }
    }

    private applyHighlightToNode(
        node: any,
        para: any,
        th: any,
        prefix: string,
        highlighted: string,
        suffix: string,
        markColor?: string,
    ) {
        const highlightBg = markColor || th.accent.amber
        switch (para.type) {
            case "heading":
                node.content = t`\n\n${fg(th.text.body)(prefix)}${bold(bg(highlightBg)(fg(th.bg.void)(highlighted)))}${fg(th.text.body)(suffix)}\n`
                break
            case "quote":
                node.content = t`\n  ${fg(th.accent.cyan)("│")} ${fg(th.text.muted)(prefix)}${bold(bg(highlightBg)(fg(th.bg.void)(highlighted)))}${fg(th.text.muted)(suffix)}\n`
                break
            case "list-item": {
                const indent = "  ".repeat((para.indent || 0) + 1)
                const bullet = para.ordered ? `${para.index}.` : "•"
                node.content = t`${indent}${fg(th.accent.cyan)(bullet)} ${fg(th.text.body)(prefix)}${bold(bg(highlightBg)(fg(th.bg.void)(highlighted)))}${fg(th.text.body)(suffix)}`
                break
            }
            default:
                node.content = t`\n${fg(th.text.body)(prefix)}${bold(bg(highlightBg)(fg(th.bg.void)(highlighted)))}${fg(th.text.body)(suffix)}\n`
                break
        }
    }

    /**
     * Compute highlight segments for a paragraph's text.
     * Returns { text, color }[] where `color` is the highlight bg hex (or null
     * for non-highlighted runs). Consecutive chars sharing the same highlight
     * color are grouped into one segment.
     */
    private computeHighlightSegments(
        text: string,
        paraIdx: number,
        highlights: HighlightRecord[],
        th: any,
    ): { text: string; color: string | null }[] {
        if (!text) return []
        const intersecting = highlights.filter(hl => {
            const ep = hl.end_paragraph_index ?? hl.paragraph_index
            return paraIdx >= hl.paragraph_index && paraIdx <= ep
        })
        if (intersecting.length === 0) return [{ text, color: null }]

        const charColors: (string | null)[] = new Array(text.length).fill(null)

        for (const hl of intersecting) {
            const sp = hl.paragraph_index
            const ep = hl.end_paragraph_index ?? hl.paragraph_index

            let startChar = 0
            let endChar = text.length - 1

            if (paraIdx === sp) startChar = Math.max(0, hl.start_char ?? 0)
            if (paraIdx === ep) endChar = Math.min(text.length - 1, hl.end_char ?? (text.length - 1))

            // Backwards compatibility for old highlights (-1 offset)
            if (hl.start_char === -1 && hl.text) {
                const parts = hl.text.split("\n")
                const offset = paraIdx - sp
                const textPart = parts[offset]
                if (textPart) {
                    const idx = text.indexOf(textPart)
                    if (idx >= 0) {
                        startChar = idx
                        endChar = idx + textPart.length - 1
                    }
                }
            }

            const color = hl.note ? th.accent.orange : (this.getHighlightBgColor(hl.color, th) || th.accent.amber)

            for (let i = startChar; i <= endChar; i++) {
                if (i >= 0 && i < text.length) charColors[i] = color
            }
        }

        const segments: { text: string; color: string | null }[] = []
        let i = 0
        while (i < text.length) {
            const cur = charColors[i] ?? null
            let j = i
            while (j < text.length && (charColors[j] ?? null) === cur) j++
            segments.push({ text: text.slice(i, j), color: cur })
            i = j
        }
        return segments
    }

    /**
     * Build styled TextChunks for a paragraph's text, applying per-segment
     * highlighting via structured StyledText (NOT raw ANSI — OpenTUI's text
     * renderables do not parse inline ANSI escapes, so escape digits would
     * leak as visible text). Non-highlighted runs get `stylePlain`; highlighted
     * runs get a bold bg + fg(void) treatment for contrast.
     */
    private buildHighlightedChunks(
        para: any,
        paraIdx: number,
        highlights: HighlightRecord[],
        th: any,
        stylePlain: (text: string) => TextChunk,
    ): TextChunk[] {
        const segments = this.computeHighlightSegments(para.text || "", paraIdx, highlights, th)
        const chunks: TextChunk[] = []
        for (const seg of segments) {
            if (seg.color) {
                chunks.push(bold(bg(seg.color)(fg(th.bg.void)(seg.text))))
            } else {
                chunks.push(stylePlain(seg.text))
            }
        }
        return chunks
    }

    private clearAllSelectionHighlights() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return
        for (let i = 0; i < chapter.paragraphs.length; i++) {
            const node = this.paraNodes[i]
            const para = chapter.paragraphs[i]
            if (node && para) {
                this.restoreParagraph(i)
            }
        }
    }

    /** Map highlight color name to theme color */
    private getHighlightBgColor(color: string, th: any): string {
        switch (color) {
            case "green": return th.accent.green
            case "blue": return th.accent.blue
            case "pink": return th.accent.pink
            default: return th.accent.amber
        }
    }

    private getStoredHighlightBgColor(color: string, hasNote: boolean, th: any): string {
        // Annotated highlights get a dedicated color so they are visually distinct from plain highlights.
        if (hasNote) return th.accent.orange
        return this.getHighlightBgColor(color, th)
    }

    private restoreParagraph(paraIdx: number) {
        const th = getTheme()
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return
        const para = chapter.paragraphs[paraIdx]
        if (!para) return

        const node = this.paraNodes[paraIdx]
        if (!node) return

        const highlights = getChapterHighlights(this.book.id, this.currentChapter)
        const plainChunk = (s: string): TextChunk => ({ __isChunk: true, text: s } as TextChunk)

        switch (para.type) {
            case "heading": {
                const levelColor =
                    para.level === 1 ? th.accent.purple :
                        para.level === 2 ? th.accent.blue :
                            para.level === 3 ? th.accent.cyan :
                                th.accent.green
                const chunks = this.buildHighlightedChunks(para, paraIdx, highlights, th,
                    (s) => bold(fg(levelColor)(s)))
                node.content = new StyledText([plainChunk("\n\n"), ...chunks, plainChunk("\n")])
                break
            }
            case "quote": {
                const chunks = this.buildHighlightedChunks(para, paraIdx, highlights, th,
                    (s) => italic(fg(th.text.muted)(s)))
                node.content = new StyledText([
                    plainChunk("\n  "),
                    fg(th.accent.cyan)("│"),
                    plainChunk(" "),
                    ...chunks,
                    plainChunk("\n"),
                ])
                break
            }
            case "list-item": {
                const indent = "  ".repeat((para.indent || 0) + 1)
                let bullet: string
                if (para.ordered) {
                    bullet = `${para.index}.`
                } else {
                    const bullets = ["•", "◦", "▪", "▸"]
                    bullet = bullets[Math.min(para.indent || 0, bullets.length - 1)]!
                }
                const chunks = this.buildHighlightedChunks(para, paraIdx, highlights, th,
                    (s) => fg(th.text.body)(s))
                node.content = new StyledText([
                    plainChunk(indent),
                    fg(th.accent.cyan)(bullet),
                    plainChunk(" "),
                    ...chunks,
                ])
                break
            }
            case "code": {
                const plainText = para.text || ""
                if (this.collapsedCodeBlocks.has(paraIdx)) {
                    const lines = plainText.split("\n")
                    const preview = lines.length > 2 ? lines.slice(0, 2).join("\n") + "\n..." : plainText
                    node.content = this.formatCodeBlock(preview, (para.language || "code") + " (Collapsed)")
                } else {
                    node.content = this.formatCodeBlock(plainText, para.language)
                }
                node.fg = th.text.body
                break
            }
            case "table": {
                const tableText = para.tableRows ? formatTable(para.tableRows) : (para.text || "")
                node.content = `\n${tableText}\n`
                node.fg = th.text.body
                break
            }
            case "note": {
                const kind = para.noteKind || "note"
                const icons: Record<string, string> = { tip: "💡", warning: "⚠️", note: "📝", important: "❗" }
                const colors: Record<string, string> = { tip: th.accent.green, warning: th.accent.amber, note: th.accent.cyan, important: th.accent.pink }
                const icon = icons[kind] || "📝"
                const color = colors[kind] || th.accent.cyan
                const chunks = this.buildHighlightedChunks(para, paraIdx, highlights, th,
                    (s) => fg(th.text.body)(s))
                node.content = new StyledText([
                    plainChunk("\n  "),
                    fg(color)("┃"),
                    plainChunk(" "),
                    plainChunk(icon),
                    plainChunk(" "),
                    bold(fg(color)(kind.toUpperCase())),
                    plainChunk("\n  "),
                    fg(color)("┃"),
                    plainChunk(" "),
                    ...chunks,
                    plainChunk("\n"),
                ])
                break
            }
            case "footnote": {
                const ref = para.footnoteRef ? `[${para.footnoteRef}]` : ""
                const chunks = this.buildHighlightedChunks(para, paraIdx, highlights, th,
                    (s) => italic(fg(th.text.muted)(s)))
                node.content = new StyledText([
                    plainChunk("\n  "),
                    fg(th.accent.cyan)("─"),
                    plainChunk(" "),
                    fg(th.text.subtle)(`📎 ${ref}`),
                    plainChunk(" "),
                    ...chunks,
                    plainChunk("\n"),
                ])
                break
            }
            case "image": {
                const src = para.imageSrc || ""
                const alt = para.imageAlt || para.text || "[Image]"
                const imageData = this.resolveImage(src)

                if (imageData && supportsImages()) {
                    const terminalImage = renderImageToTerminal(imageData, {
                        width: Math.min(60, (this.readingPane.viewport?.width || 80) - 10),
                    })
                    let content = `\n${terminalImage}\n`
                    if (alt && alt !== "[Image]") {
                        content += `  ${fg(th.text.subtle)(italic(`↑ ${alt}`))}\n`
                    }
                    node.content = content
                } else {
                    const caption = alt !== "[Image]" ? alt : (para.text || "Image")
                    node.content = t`\n  ${fg(th.accent.cyan)("┌─────────────────────────────────┐")}\n  ${fg(th.accent.cyan)("│")}  ${fg(th.text.muted)("🖼️  ")}${fg(th.text.body)(caption.slice(0, 28).padEnd(28))} ${fg(th.accent.cyan)("│")}\n  ${fg(th.accent.cyan)("└─────────────────────────────────┘")}\n`
                }
                break
            }
            default: {
                // Apply inline rich formatting (`code`/bold/italic) to non-highlighted
                // segments; highlighted segments get a clean bg via structured chunks.
                const segments = this.computeHighlightSegments(para.text || "", paraIdx, highlights, th)
                const chunks: TextChunk[] = []
                for (const seg of segments) {
                    if (seg.color) {
                        chunks.push(bold(bg(seg.color)(fg(th.bg.void)(seg.text))))
                    } else {
                        chunks.push(...formatInlineRichText(seg.text).chunks)
                    }
                }
                if (chunks.length === 0) {
                    node.content = ""
                } else {
                    node.content = new StyledText([plainChunk("\n"), ...chunks, plainChunk("\n")])
                }
                node.fg = th.text.body
                break
            }
        }
    }

    // ── Actions ──────────────────────────────────────────────────

    private toggleMinimap() {
        this.minimapVisible = !this.minimapVisible
        this.minimapContainer.visible = this.minimapVisible
        if (this.minimapVisible) {
            this.updateMinimap()
            this.minimapInterval = setInterval(() => this.updateMinimap(), 100)
        } else {
            if (this.minimapInterval) clearInterval(this.minimapInterval)
            this.minimapInterval = null
        }
        showToast(this.renderer, this.minimapVisible ? "🗺️ Minimap ON" : "🗺️ Minimap OFF", "info")
    }

    private updateMinimap() {
        if (!this.minimapVisible) return

        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        const th = getTheme()
        const P = chapter.paragraphs.length
        if (P === 0) return

        // Estimate available height
        const H = Math.max(10, this.minimapContainer.height || 40)

        const lines: string[] = []

        const viewportTop = this.readingPane.scrollTop
        const viewportBottom = viewportTop + this.readingPane.viewport.height

        for (let l = 0; l < H; l++) {
            const startP = Math.floor((l / H) * P)
            const endP = Math.max(startP + 1, Math.floor(((l + 1) / H) * P))

            let char = "│"
            let color = th.border.normal
            let isVisible = false

            for (let p = startP; p < endP; p++) {
                const para = chapter.paragraphs[p]
                const node = this.paraNodes[p]
                if (!para || !node) continue

                const nodeTop = node.y
                const nodeBottom = nodeTop + (node.height || 1)

                if (nodeBottom >= viewportTop && nodeTop <= viewportBottom) {
                    isVisible = true
                }

                if (para.type === "heading") {
                    char = "█"
                    color = th.accent.cyan
                } else if (para.type === "code" && char !== "█") {
                    char = "■"
                    color = th.accent.green
                } else if (para.type === "quote" && char === "│") {
                    char = "┃"
                    color = th.accent.purple
                } else if (char === "│" && para.text.length > 0) {
                    char = "┃"
                }
            }

            if (isVisible) {
                lines.push(` ${bg(th.bg.hover)(fg(th.text.body)(char))} `)
            } else {
                lines.push(` ${bg(th.bg.void)(fg(color)(char))} `)
            }
        }

        this.minimapContent.content = lines.join("\n")
    }

    private toggleTTS(selectionOnly = false) {
        if (TTSService.isPlaying()) {
            TTSService.stop()
            showToast(this.renderer, "🔇 TTS stopped", "info")
            return
        }

        let text = ""
        if (selectionOnly) {
            text = this.getSelectedText()
            if (!text) text = this.getParaText(this.selectParaIdx)
        } else {
            const chapter = this.parsedBook.chapters[this.currentChapter]
            if (chapter) {
                text = chapter.paragraphs.map(p => p.text).join(" ")
            }
        }

        const cleanText = text.replace(/[^a-zA-Z0-9 .,!?;:'"-]/g, "") // remove weird ansi/markdown chars
        if (!cleanText.trim()) {
            showToast(this.renderer, "Nothing to read", "error")
            return
        }

        showToast(this.renderer, "🔊 Playing TTS...", "info")
        TTSService.play(
            cleanText,
            () => {
                showToast(this.renderer, "🔇 TTS finished", "info")
            },
            () => {
                showToast(this.renderer, "Failed to start TTS (is espeak/say installed?)", "error")
            }
        )
    }

    private confirmSelect() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return
        const para = chapter.paragraphs[this.selectParaIdx]

        if (!this.visualMode && para?.type === "code") {
            this.modalOpen = true
            this.codeModal = new CodeModal(this.renderer, () => {
                this.modalOpen = false
                this.readingPane.focus()
            })
            this.codeModal.show(para.text, para.language)
            return
        }

        const selected = this.getSelectedText()
        const clean = selected.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
        if (clean) {
            this.lastSelectedText = clean
            showToast(this.renderer, `✎ "${truncate(clean, 40)}" selected — press D for dictionary`, "success")
        }
        this.exitSelectMode()
    }

    private toggleCodeCollapse() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return
        const para = chapter.paragraphs[this.selectParaIdx]

        if (para?.type === "code") {
            if (this.collapsedCodeBlocks.has(this.selectParaIdx)) {
                this.collapsedCodeBlocks.delete(this.selectParaIdx)
                showToast(this.renderer, "Code block expanded", "info")
            } else {
                this.collapsedCodeBlocks.add(this.selectParaIdx)
                showToast(this.renderer, "Code block collapsed", "info")
            }
            this.restoreParagraph(this.selectParaIdx)
            this.renderSelection()
        }
    }

    private copySelectedOrCode() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return
        const para = chapter.paragraphs[this.selectParaIdx]

        let textToCopy = ""
        if (this.visualMode) {
            textToCopy = this.getSelectedText().trim()
        } else if (para?.type === "code") {
            textToCopy = para.text
        } else {
            textToCopy = this.getParaText(this.selectParaIdx)
        }

        if (!textToCopy) {
            showToast(this.renderer, "Nothing to copy", "error")
            return
        }

        try {
            const success = this.renderer.copyToClipboardOSC52(textToCopy)
            if (success) {
                showToast(this.renderer, "📋 Copied to clipboard", "success")
                this.exitSelectMode()
            } else {
                showToast(this.renderer, "Terminal doesn't support clipboard (OSC52)", "error")
            }
        } catch (err) {
            showToast(this.renderer, "Failed to copy", "error")
        }
    }

    private confirmSelectAndDict() {
        const selected = this.getSelectedText()
        const clean = selected.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")
        this.exitSelectMode()
        if (clean) {
            this.showDictionary(clean)
        }
    }

    private highlightSelectedText() {
        const chapterIndex = this.currentChapter
        const chapter = this.parsedBook.chapters[chapterIndex]
        if (!chapter) return
        const scrollTop = this.readingPane.scrollTop

        const selectedText = this.getSelectedText()
        if (!selectedText) return

        const { sp, ep, sc, ec } = this.getSelectionRange()

        addHighlight(
            this.book.id,
            chapterIndex,
            sp,
            ep,
            sc,
            ec,
            selectedText,
            this.highlightColor,
        )

        const colorIcons: Record<string, string> = { yellow: "🟡", green: "🟢", blue: "🔵", pink: "🩷" }
        const icon = colorIcons[this.highlightColor] || "📌"
        showToast(this.renderer, `${icon} Highlighted (${this.highlightColor}): "${selectedText.slice(0, 30)}${selectedText.length > 30 ? "…" : ""}"`, "success")
        this.exitSelectMode()
        this.rerenderCurrentChapterPreserveViewport(chapterIndex, scrollTop)
    }

    /** Add a highlighted note — highlight with an inline note annotation */
    private highlightWithNote() {
        const selectedText = this.getSelectedText()
        if (!selectedText) {
            showToast(this.renderer, "Select text first (v for visual mode)", "error")
            return
        }

        this.modalOpen = true
        this.annotationModal = new AnnotationModal(
            this.renderer,
            (note: string) => {
                const chapterIndex = this.currentChapter
                const scrollTop = this.readingPane.scrollTop
                this.modalOpen = false
                const { sp, ep, sc, ec } = this.getSelectionRange()

                addHighlight(
                    this.book.id,
                    chapterIndex,
                    sp,
                    ep,
                    sc,
                    ec,
                    selectedText,
                    this.highlightColor,
                    note,
                )

                showToast(this.renderer, `📝 Annotation saved`, "success")
                this.exitSelectMode()
                this.rerenderCurrentChapterPreserveViewport(chapterIndex, scrollTop)
            },
            () => {
                this.modalOpen = false
                showToast(this.renderer, "Annotation cancelled", "info")
                this.exitSelectMode()
            }
        )
        this.annotationModal.show()
    }

    // ── Search match navigation (n/N) ──────────────────────────────

    private buildSearchMatches(query: string) {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        this.searchMatches = []
        const q = query.toLowerCase()

        for (let pi = 0; pi < chapter.paragraphs.length; pi++) {
            const text = chapter.paragraphs[pi]?.text || ""
            const lower = text.toLowerCase()
            let idx = 0
            while ((idx = lower.indexOf(q, idx)) !== -1) {
                this.searchMatches.push({ paraIdx: pi, charIdx: idx })
                idx += q.length
            }
        }

        this.searchMatchIndex = -1
        if (this.searchMatches.length > 0) {
            showToast(this.renderer, `🔍 ${this.searchMatches.length} matches in this chapter — n/N to navigate`, "info")
        }
    }

    private jumpToNextSearchMatch(delta: number) {
        if (!this.lastSearchQuery || this.searchMatches.length === 0) {
            showToast(this.renderer, "No search results — press / to search first", "info")
            return
        }

        this.searchMatchIndex += delta
        if (this.searchMatchIndex >= this.searchMatches.length) this.searchMatchIndex = 0
        if (this.searchMatchIndex < 0) this.searchMatchIndex = this.searchMatches.length - 1

        const match = this.searchMatches[this.searchMatchIndex]
        if (!match) return

        // Scroll to the match
        const estimatedLine = this.getEstimatedLineOffset(match.paraIdx)
        const viewportHeight = this.readingPane.viewport?.height || 30
        this.readingPane.scrollTo(Math.max(0, estimatedLine - Math.floor(viewportHeight / 3)))

        // Enter select mode at the match
        this.selectMode = true
        this.visualMode = false
        this.selectionAnchor = null
        this.pendingMotionCount = ""
        this.selectParaIdx = match.paraIdx
        this.selectCharIdx = match.charIdx
        
        if (this.statusBarMounted) {
            try { this.statusBar.setMode("select") } catch { }
        }
        
        this.renderSelection()

        showToast(this.renderer, `🔍 Match ${this.searchMatchIndex + 1}/${this.searchMatches.length}`, "info")
    }

    // ── Deep Link ───────────────────────────────────────────────

    private async copyDeepLink() {
        // Estimate current paragraph from scroll position
        const viewportTop = this.readingPane.scrollTop
        let currentPara = 0
        for (let i = 0; i < this.paraNodes.length; i++) {
            const offset = this.getEstimatedLineOffset(i)
            if (offset > viewportTop) break
            currentPara = i
        }

        const link = generateDeepLink(this.book.id, this.currentChapter, currentPara)
        const success = await copyDeepLinkToClipboard(link)
        if (success) {
            showToast(this.renderer, `📎 Copied: ${link}`, "success")
        } else {
            showToast(this.renderer, `📎 Link: ${link} (clipboard unavailable)`, "info")
        }
    }

    // ── Cross-book export ───────────────────────────────────────

    private exportAllAnnotationsAction() {
        const result = exportAllAnnotations()
        if (result.success) {
            showToast(this.renderer, `📝 Exported ${result.count} annotations → ${result.path}`, "success")
        } else {
            showToast(this.renderer, `Export failed: ${result.error}`, "error")
        }
    }

    // ── Image resolution ────────────────────────────────────────

    private resolveImage(src: string): Buffer | undefined {
        if (!src || !this.parsedBook.imageMap) return undefined
        const map = this.parsedBook.imageMap

        const normalize = (v: string): string =>
            (v || "")
                .trim()
                .replace(/\\/g, "/")
                .replace(/^\.\//, "")
                .replace(/^\//, "")
                .split("#")[0]!
                .split("?")[0]!

        const chapterHref = this.parsedBook.chapters[this.currentChapter]?.sourceHref || ""
        const chapterDir = chapterHref.includes("/")
            ? chapterHref.slice(0, chapterHref.lastIndexOf("/") + 1)
            : ""

        const decodeURIComponentSafe = (v: string): string => {
            try { return decodeURIComponent(v) } catch { return v }
        }

        const raw = normalize(src)
        const candidates = new Set<string>()
        const addCandidate = (v: string) => {
            if (!v) return
            candidates.add(v)
            candidates.add(v.toLowerCase())
            candidates.add(decodeURIComponentSafe(v))
            candidates.add(decodeURIComponentSafe(v).toLowerCase())
            candidates.add(v.replace(/^\.\//, ""))
            candidates.add(v.replace(/^\//, ""))
        }

        addCandidate(src)
        addCandidate(raw)

        // Relative-to-chapter asset references (../images/foo.png etc.)
        if (chapterDir && raw) {
            addCandidate(pathPosix.normalize(pathPosix.join(chapterDir, raw)))
            addCandidate(pathPosix.normalize(pathPosix.join(chapterDir, "./" + raw)))
        }

        const fileName = raw.split("/").pop() || ""
        if (fileName) addCandidate(fileName)

        const getBuffer = (key: string): Buffer | undefined => {
            const path = map.get(key)
            if (!path) return undefined
            try {
                return require("fs").readFileSync(path)
            } catch {
                return undefined
            }
        }

        for (const candidate of candidates) {
            const buf = getBuffer(candidate)
            if (buf) return buf
        }

        // Try stripping epub2 virtual image prefix
        for (const candidate of candidates) {
            const stripped = candidate.replace(/^images\/[^/]+\//, "")
            let buf = getBuffer(stripped)
            if (buf) return buf
            
            const strippedAbs = candidate.replace(/^\/images\/[^/]+\//, "")
            buf = getBuffer(strippedAbs)
            if (buf) return buf
        }

        // Fallback: suffix match (filename or trailing path)
        const tail2 = raw.split("/").slice(-2).join("/")
        for (const [key, path] of map) {
            if ((fileName && key.endsWith(fileName)) || (tail2 && key.endsWith(tail2))) {
                try {
                    return require("fs").readFileSync(path)
                } catch {
                    // ignore
                }
            }
        }

        return undefined
    }

    // ── Cleanup ─────────────────────────────────────────────────

    destroy() {
        // Guard against double-destroy and stop all timers first
        if (this.destroyed) return
        this.saveScrollPosition()
        this.destroyed = true

        if (this.timerInterval) {
            clearInterval(this.timerInterval)
            this.timerInterval = null
        }
        if (this.minimapInterval) {
            clearInterval(this.minimapInterval)
            this.minimapInterval = null
        }
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
        }
        this.recordSessionStats()
        this.stopAutoScroll()
        this.helpOverlay?.destroy()
        this.tocModal?.destroy()
        this.searchModal?.destroy()
        this.annotationModal?.hide()
        this.bookmarksPanel?.destroy()
        this.dictionaryModal?.destroy()
        this.vocabularyPanel?.destroy()
        this.annotationsPanel?.destroy()
        this.rsvpReader?.destroy()
        if (this.statusBarMounted) {
            try { this.statusBar.destroy() } catch { }
            this.statusBarMounted = false
        }
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
