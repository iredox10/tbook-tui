// ─────────────────────────────────────────────────────────────
// Reader View — the main reading experience
// Phase 2-4: zoom, auto-scroll, stats, theme, PDF, modals,
//            export, dictionary, config, mouse
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    CliRenderEvents,
    t, bold, italic, fg, bg,
} from "@opentui/core"
import { theme, truncate, progressBar, progressColor, formatDuration, getActiveTheme, setActiveTheme, getTheme } from "../utils/theme"
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

        if (this.timerInterval) clearInterval(this.timerInterval)
        this.timerInterval = setInterval(() => {
            this.updateStatusProgress()
        }, 5000)

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
                content: t` ${fg(markerColor)(markerStr)}${fg(labelColor)(`${num}. ${truncate(ch.title, 13)}`)}`,
            })

            this.sidebar.add(item)
            this.sidebarItems.push(item)
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
            content: `\n  ${fg(th.text.subtle)("◆  ◆  ◆")}\n`,
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
                    // Regular paragraph — style inline code markers
                    let content = p.text || ""
                    if (content.includes("`")) {
                        // Replace `code` backtick markers with styled inline code
                        content = content.replace(/`([^`]+)`/g, (_, code) => {
                            return `\x1b[36m\x1b[48;5;236m ${code} \x1b[0m`
                        })
                        node = new TextRenderable(this.renderer, {
                            id: `para-${i}`,
                            ...textProps,
                            content: content ? `\n${content}\n` : "",
                        })
                    } else {
                        node = new TextRenderable(this.renderer, {
                            id: `para-${i}`,
                            ...textProps,
                            content: content ? `\n${content}\n` : "",
                            fg: th.text.body,
                        })
                    }
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

        // Apply saved highlights from database
        const highlights = getChapterHighlights(this.book.id, this.currentChapter)
        for (const hl of highlights) {
            if (!hl.text) continue
            const parts = hl.text.split("\n")
            for (let i = 0; i < parts.length; i++) {
                const textPart = parts[i]
                if (!textPart) continue
                const node = this.paraNodes[hl.paragraph_index + i]
                if (node) {
                    const bgColorCode = this.getHighlightBgColor(hl.color, th)
                    const bgAnsi = this.hexToAnsiBg(bgColorCode)
                    const fgAnsi = this.hexToAnsiFg(th.bg.void)
                    const escapedText = textPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    const regex = new RegExp(escapedText, "g")
                    node.content = String(node.content as any).replace(regex, (match: string) => {
                        return `${bgAnsi}${fgAnsi}${match}\x1b[0m`
                    })
                }
            }
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
        if (this.destroyed) return

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

        this.statusBar.setReaderProgress(
            this.currentChapter,
            this.parsedBook.chapters.length,
            percent,
            timeInfo,
            chapterPercent
        )

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
                switch (sequence) {
                    case "\x1b": // Escape — exit select mode
                    case "s":    // toggle off
                    case "q":    // exit select mode
                        this.exitSelectMode()
                        return true
                    case "j":
                    case "\x1b[B": // down — next paragraph
                        this.selectMoveParagraph(1)
                        return true
                    case "k":
                    case "\x1b[A": // up — prev paragraph
                        this.selectMoveParagraph(-1)
                        return true
                    case "l":
                    case "\x1b[C": // right — next char
                        this.selectMoveChar(1)
                        return true
                    case "h":
                    case "\x1b[D": // left — prev char
                        this.selectMoveChar(-1)
                        return true
                    case "w": // advance word
                        this.selectMoveWord(1)
                        return true
                    case "b": // prev word
                        this.selectMoveWord(-1)
                        return true
                    case " ": // space — advance word
                        this.selectMoveWord(1)
                        return true
                    case "\r":
                    case "\n": // enter — confirm selection
                        this.confirmSelect()
                        return true
                    case "c":
                    case "C": // copy
                        this.copySelectedOrCode()
                        return true
                    case "-":
                    case "_":
                    case "+":
                    case "=":
                        this.toggleCodeCollapse()
                        return true
                    case "D":
                    case "d": // dictionary with selected word
                        this.confirmSelectAndDict()
                        return true
                    case "m": // mark/highlight selected text
                    case "M":
                        this.highlightSelectedText()
                        return true
                    case "v": // toggle visual selection (set anchor)
                    case "V":
                        this.toggleVisualMode()
                        return true
                    case "E":
                    case "e": // AI Explain
                        this.showAiExplain()
                        return true
                    case "p":
                    case "P": // TTS
                        this.toggleTTS(true)
                        return true
                    // Multi-color highlight selection (1-4)
                    case "1":
                        this.highlightColor = "yellow"
                        showToast(this.renderer, "🟡 Highlight color: Yellow", "info")
                        return true
                    case "2":
                        this.highlightColor = "green"
                        showToast(this.renderer, "🟢 Highlight color: Green", "info")
                        return true
                    case "3":
                        this.highlightColor = "blue"
                        showToast(this.renderer, "🔵 Highlight color: Blue", "info")
                        return true
                    case "4":
                        this.highlightColor = "pink"
                        showToast(this.renderer, "🩷 Highlight color: Pink", "info")
                        return true
                    case "n": // Add note to highlight
                        this.highlightWithNote()
                        return true
                }
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

                // Phase 4: Export to Obsidian/Logseq
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
            this.statusBar.destroy()
            showToast(this.renderer, "🎯 Focus mode ON — press f to restore", "info")
        } else {
            this.sidebarVisible = true
            this.sidebar.width = 20
            // Recreate status bar (it was destroyed)
            this.statusBar = new StatusBar({ renderer: this.renderer, mode: "reader" })
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
        if (!chapter || chapter.paragraphs.length === 0) return 0

        const clamped = Math.max(0, Math.min(startIdx, chapter.paragraphs.length - 1))
        if (this.getParaText(clamped).length > 0) return clamped

        for (let radius = 1; radius < chapter.paragraphs.length; radius++) {
            const left = clamped - radius
            if (left >= 0 && this.getParaText(left).length > 0) return left
            const right = clamped + radius
            if (right < chapter.paragraphs.length && this.getParaText(right).length > 0) return right
        }

        return clamped
    }

    private enterSelectMode() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter || chapter.paragraphs.length === 0) return

        this.selectMode = true
        this.visualMode = false
        this.selectionAnchor = null

        // Anchor selection to current viewport using text-layout estimates.
        const viewportTop = this.readingPane.scrollTop
        const viewportHeight = this.readingPane.viewport?.height || 30
        const targetLine = viewportTop + Math.floor(viewportHeight / 3)
        let estimatedIdx = 0
        let cumulativeTop = 6

        for (let i = 0; i < chapter.paragraphs.length; i++) {
            const span = this.getEstimatedParagraphLineSpan(i)
            const bottom = cumulativeTop + span - 1
            if (targetLine <= bottom) {
                estimatedIdx = i
                break
            }
            estimatedIdx = i
            cumulativeTop += span
        }

        this.selectParaIdx = this.findNearestSelectableParagraph(estimatedIdx)
        this.selectCharIdx = 0

        this.statusBar.setMode("select")
        showToast(this.renderer, "✎ SELECT — h/l char · w/b word · j/k para · v visual · c copy · Enter open code · Esc exit", "info")
        this.renderSelection()
    }

    private exitSelectMode() {
        if (!this.selectMode) return
        this.clearAllSelectionHighlights()
        this.selectMode = false
        this.visualMode = false
        this.selectionAnchor = null
        this.statusBar.setMode("reader")
    }

    private toggleVisualMode() {
        if (this.visualMode) {
            this.clearAllSelectionHighlights()
            this.visualMode = false
            this.selectionAnchor = null
            showToast(this.renderer, "✎ Visual off — single char cursor", "info")
        } else {
            this.visualMode = true
            this.selectionAnchor = { paraIdx: this.selectParaIdx, charIdx: this.selectCharIdx }
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
            while (i < text.length && text[i] !== ' ') i++
            while (i < text.length && text[i] === ' ') i++
            if (i >= text.length) return this.selectMoveParagraph(1, true)
        } else {
            i--
            while (i >= 0 && text[i] === ' ') i--
            while (i >= 0 && text[i] !== ' ') i--
            i++ // Start of word
            if (i < 0) return this.selectMoveParagraph(-1, true)
        }
        this.selectCharIdx = Math.max(0, Math.min(i, text.length - 1))
        this.renderSelection()
    }

    private selectMoveParagraph(delta: number, jumpToEnd = false) {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        let newIdx = this.selectParaIdx + delta
        while (newIdx >= 0 && newIdx < chapter.paragraphs.length && this.getParaText(newIdx).length === 0) {
            newIdx += delta
        }
        if (newIdx < 0 || newIdx >= chapter.paragraphs.length) return

        if (!this.visualMode) this.restoreParagraph(this.selectParaIdx)
        this.selectParaIdx = newIdx
        this.selectCharIdx = jumpToEnd && delta < 0 ? Math.max(0, this.getParaText(newIdx).length - 1) : 0
        this.renderSelection()
    }

    /** Render the current selection highlight */
    private renderSelection() {
        const th = getTheme()
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        if (this.visualMode && this.selectionAnchor) {
            // Visual mode: highlight full range between anchor and cursor
            this.clearAllSelectionHighlights()
            const { sp, sc, ep, ec } = this.getSelectionRange()

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

                this.applyHighlightToNode(node, para, th, prefix, highlighted, suffix)
            }
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

            this.applyHighlightToNode(node, para, th, prefix, highlighted, suffix)
        }

        // Only scroll if the cursor paragraph is outside the visible viewport
        const estimatedLine = this.getEstimatedLineOffset(this.selectParaIdx)
        const viewportTop = this.readingPane.scrollTop
        const viewportHeight = this.readingPane.viewport?.height || 30
        const viewportBottom = viewportTop + viewportHeight

        if (estimatedLine < viewportTop + 2 || estimatedLine > viewportBottom - 3) {
            // Cursor is outside visible area — scroll to center it
            this.readingPane.scrollTo(Math.max(0, estimatedLine - Math.floor(viewportHeight / 2)))
        }
    }

    private applyHighlightToNode(node: any, para: any, th: any, prefix: string, highlighted: string, suffix: string) {
        applyWordHighlight(node, para, th, prefix, highlighted, suffix)
    }

    private clearAllSelectionHighlights() {
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return
        const th = getTheme()
        for (let i = 0; i < chapter.paragraphs.length; i++) {
            const nodeIdx = i + 3
            const node = this.chapterTextNodes[nodeIdx]
            const para = chapter.paragraphs[i]
            if (node && para) {
                const restored = renderParagraph(this.renderer, para, i, th)
                node.content = restored.content
                node.fg = restored.fg
            }
        }

        // Re-apply database highlights that were cleared by restoreParagraph
        this.reapplyDatabaseHighlights()
    }

    /** Re-apply persistent highlights from the database */
    private reapplyDatabaseHighlights() {
        const th = getTheme()
        const highlights = getChapterHighlights(this.book.id, this.currentChapter)
        for (const hl of highlights) {
            if (!hl.text) continue
            const parts = hl.text.split("\n")
            for (let i = 0; i < parts.length; i++) {
                const textPart = parts[i]
                if (!textPart) continue
                const node = this.paraNodes[hl.paragraph_index + i]
                if (node) {
                    const bgColorCode = this.getHighlightBgColor(hl.color, th)
                    const bgAnsi = this.hexToAnsiBg(bgColorCode)
                    const fgAnsi = this.hexToAnsiFg(th.bg.void)
                    const escapedText = textPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    const regex = new RegExp(escapedText, "g")
                    node.content = String(node.content as any).replace(regex, (match: string) => {
                        return `${bgAnsi}${fgAnsi}${match}\x1b[0m`
                    })
                }
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

    private hexToAnsiBg(hex: string) {
        if (!hex || hex.length < 7) return ""
        const r = parseInt(hex.slice(1, 3), 16)
        const g = parseInt(hex.slice(3, 5), 16)
        const b = parseInt(hex.slice(5, 7), 16)
        return `\x1b[48;2;${r};${g};${b}m`
    }

    private hexToAnsiFg(hex: string) {
        if (!hex || hex.length < 7) return ""
        const r = parseInt(hex.slice(1, 3), 16)
        const g = parseInt(hex.slice(3, 5), 16)
        const b = parseInt(hex.slice(5, 7), 16)
        return `\x1b[38;2;${r};${g};${b}m`
    }

    private restoreParagraph(paraIdx: number) {
        const th = getTheme()
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return
        const para = chapter.paragraphs[paraIdx]
        if (!para) return

        const node = this.paraNodes[paraIdx]
        if (!node) return

        // Restore original content (no ANSI highlights)
        switch (para.type) {
            case "heading":
                node.content = t`\n\n${bold(fg(
                    para.level === 1 ? th.accent.purple :
                        para.level === 2 ? th.accent.blue :
                            para.level === 3 ? th.accent.cyan :
                                th.accent.green
                )(para.text))}\n`
                break
            case "quote":
                node.content = t`\n  ${fg(th.accent.cyan)("│")} ${italic(fg(th.text.muted)(para.text))}\n`
                break
            case "list-item": {
                const indent = "  ".repeat((para.indent || 0) + 1)
                let bullet: string
                if (para.ordered) {
                    bullet = `${para.index}.`
                } else {
                    const bullets = ["•", "◦", "▪", "▸"]
                    bullet = bullets[Math.min(para.indent || 0, bullets.length - 1)]!
                }
                node.content = t`${indent}${fg(th.accent.cyan)(bullet)} ${fg(th.text.body)(para.text)}`
                break
            }
            case "code": {
                if (this.collapsedCodeBlocks.has(paraIdx)) {
                    const lines = para.text.split("\n")
                    const preview = lines.length > 2 ? lines.slice(0, 2).join("\n") + "\n..." : para.text
                    node.content = this.formatCodeBlock(preview, (para.language || "code") + " (Collapsed)")
                } else {
                    node.content = this.formatCodeBlock(para.text, para.language)
                }
                node.fg = th.text.body
                break
            }
            case "table": {
                const tableText = para.tableRows ? formatTable(para.tableRows) : para.text
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
                node.content = t`\n  ${fg(color)("┃")} ${icon} ${bold(fg(color)(kind.toUpperCase()))}\n  ${fg(color)("┃")} ${fg(th.text.body)(para.text)}\n`
                break
            }
            case "footnote": {
                const ref = para.footnoteRef ? `[${para.footnoteRef}]` : ""
                node.content = t`\n  ${fg(th.accent.cyan)("─")} ${fg(th.text.subtle)(`📎 ${ref}`)} ${italic(fg(th.text.muted)(para.text))}\n`
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
                    const caption = alt !== "[Image]" ? alt : para.text || "Image"
                    node.content = t`\n  ${fg(th.accent.cyan)("┌─────────────────────────────────┐")}\n  ${fg(th.accent.cyan)("│")}  ${fg(th.text.muted)("🖼️  ")}${fg(th.text.body)(caption.slice(0, 28).padEnd(28))} ${fg(th.accent.cyan)("│")}\n  ${fg(th.accent.cyan)("└─────────────────────────────────┘")}\n`
                }
                break
            }
            default: {
                let content = para.text || ""
                if (content.includes("`")) {
                    content = content.replace(/`([^`]+)`/g, (_: string, code: string) => {
                        return `\x1b[36m\x1b[48;5;236m ${code} \x1b[0m`
                    })
                    node.content = content ? `\n${content}\n` : ""
                } else {
                    node.content = content ? `\n${content}\n` : ""
                    node.fg = th.text.body
                }
                break
            }
        }

        // Re-apply database highlight for this paragraph if it exists
        const highlights = getChapterHighlights(this.book.id, this.currentChapter)
        for (const hl of highlights) {
            if (!hl.text) continue
            const parts = hl.text.split("\n")
            const offset = paraIdx - hl.paragraph_index
            if (offset >= 0 && offset < parts.length) {
                const textPart = parts[offset]
                if (!textPart) continue
                const th2 = getTheme()
                const bgColorCode = this.getHighlightBgColor(hl.color, th2)
                const bgAnsi = this.hexToAnsiBg(bgColorCode)
                const fgAnsi = this.hexToAnsiFg(th2.bg.void)
                const escapedText = textPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                const regex = new RegExp(escapedText, "g")
                node.content = String(node.content as any).replace(regex, (match: string) => {
                    return `${bgAnsi}${fgAnsi}${match}\x1b[0m`
                })
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
        const chapter = this.parsedBook.chapters[this.currentChapter]
        if (!chapter) return

        const selectedText = this.getSelectedText()
        if (!selectedText) return

        const { sp } = this.getSelectionRange()

        addHighlight(
            this.book.id,
            this.currentChapter,
            sp,
            selectedText,
            this.highlightColor,
        )

        const colorIcons: Record<string, string> = { yellow: "🟡", green: "🟢", blue: "🔵", pink: "🩷" }
        const icon = colorIcons[this.highlightColor] || "📌"
        showToast(this.renderer, `${icon} Highlighted (${this.highlightColor}): "${selectedText.slice(0, 30)}${selectedText.length > 30 ? "…" : ""}"`, "success")
        this.exitSelectMode()
        this.renderChapter()
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
                this.modalOpen = false
                const { sp } = this.getSelectionRange()

                addHighlight(
                    this.book.id,
                    this.currentChapter,
                    sp,
                    selectedText,
                    this.highlightColor,
                    note,
                )

                showToast(this.renderer, `📝 Annotation saved`, "success")
                this.exitSelectMode()
                this.renderChapter()
            },
            () => {
                this.modalOpen = false
                showToast(this.renderer, "Annotation cancelled", "info")
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

        // Try exact match
        if (map.has(src)) return map.get(src)

        // Try decoded URL
        try {
            const decoded = decodeURIComponent(src)
            if (map.has(decoded)) return map.get(decoded)
        } catch { }

        // Try just the filename part
        const fileName = src.split("/").pop() || ""
        if (fileName && map.has(fileName)) return map.get(fileName)

        // Try stripping leading /images/ prefix (epub2 format)
        const stripped = src.replace(/^\/images\/[^/]+\//, "")
        if (map.has(stripped)) return map.get(stripped)

        // Try each key in map that ends with the same filename
        for (const [key, buf] of map) {
            if (key.endsWith(fileName) || key.endsWith(src.split("/").slice(-2).join("/"))) {
                return buf
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
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
