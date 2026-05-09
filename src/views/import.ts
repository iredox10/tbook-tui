// ─────────────────────────────────────────────────────────────
// Import View — scan filesystem for EPUB & PDF files and import
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    InputRenderable, InputRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, truncate, spinnerFrames, progressBar, progressColor } from "../utils/theme"
import { insertBook, getBookByPath } from "../services/database"
import { parseEpub } from "../services/epub-parser"
import { parsePdf, hasPdfSupport } from "../services/pdf-parser"
import { loadConfig, updateConfig } from "../services/config"
import { StatusBar } from "../components/status-bar"
import { showToast } from "../components/toast"
import type { App } from "../app"
import { readdir, stat } from "fs/promises"
import { existsSync, statSync } from "fs"
import { join, extname, basename, dirname, relative } from "path"
import { homedir } from "os"

interface FoundFile {
    name: string
    path: string
    dir: string
    sizeBytes: number
    size: string
    format: "epub" | "pdf" | "md" | "txt"
    alreadyImported: boolean
    selected: boolean
}

type SortMode = "name" | "size" | "format"

export class ImportView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private fileList!: ScrollBoxRenderable
    private statusBar!: StatusBar
    private pathInput!: InputRenderable
    private headerText!: TextRenderable
    private hintText!: TextRenderable
    private files: FoundFile[] = []
    private filteredFiles: FoundFile[] = []
    private selectedIndex = 0
    private scanning = false
    private importing = false
    private importCancelled = false
    private cardRenderables: BoxRenderable[] = []
    private selectedForBatch: Set<string> = new Set()
    private inputHandler?: (sequence: string) => boolean
    private searchQuery = ""
    private searchActive = false
    private searchInput!: InputRenderable
    private searchRow!: BoxRenderable
    private sortMode: SortMode = "name"
    private scanPath = ""
    private scanDepth = loadConfig().scanDepth || 3
    private previewVisible = false
    private previewBox: BoxRenderable | null = null

    constructor(renderer: CliRenderer, app: App) {
        this.renderer = renderer
        this.app = app
    }

    render() {
        this.container = new BoxRenderable(this.renderer, {
            id: "import-root",
            width: "100%",
            height: "100%",
            flexDirection: "column",
            backgroundColor: theme.bg.void,
        })

        // ── Header ──
        const header = new BoxRenderable(this.renderer, {
            id: "import-header",
            width: "100%",
            height: 3,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: 2,
            gap: 2,
            backgroundColor: theme.bg.surface,
            borderStyle: "single",
            borderColor: theme.border.normal,
        })

        this.headerText = new TextRenderable(this.renderer, {
            id: "import-title",
            content: t`${bold(fg(theme.accent.green)("📂 Import Books"))}`,
        })
        header.add(this.headerText)

        // ── Path input ──
        const pathRow = new BoxRenderable(this.renderer, {
            id: "import-path-row",
            width: "100%",
            height: 3,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: 2,
            paddingRight: 2,
            gap: 1,
        })

        const pathLabel = new TextRenderable(this.renderer, {
            id: "import-path-label",
            content: t`${fg(theme.text.muted)("Scan path:")}`,
        })

        this.pathInput = new InputRenderable(this.renderer, {
            id: "import-path-input",
            width: 50,
            value: homedir(),
            placeholder: "/path/to/books",
            backgroundColor: theme.bg.card,
            focusedBackgroundColor: theme.bg.hover,
            textColor: theme.text.body,
            cursorColor: theme.accent.green,
        })

        pathRow.add(pathLabel)
        pathRow.add(this.pathInput)

        // Quick paths
        const quickPaths = new BoxRenderable(this.renderer, {
            id: "import-quick-paths",
            width: "100%",
            height: 1,
            flexDirection: "row",
            paddingLeft: 2,
            gap: 2,
        })

        const shortcuts = [
            { key: "1", path: homedir(), label: "~ Home" },
            { key: "2", path: join(homedir(), "Documents"), label: "📄 Documents" },
            { key: "3", path: join(homedir(), "Downloads"), label: "⬇ Downloads" },
        ]

        for (const sc of shortcuts) {
            quickPaths.add(new TextRenderable(this.renderer, {
                id: `quick-${sc.key}`,
                content: t`${fg(theme.accent.cyan)(sc.key)} ${fg(theme.text.subtle)(sc.label)}`,
            }))
        }

        // Recent paths row — shows last 3 saved scan dirs from config
        const recentRow = new BoxRenderable(this.renderer, {
            id: "import-recent-row",
            width: "100%",
            height: 0,
            flexDirection: "row",
            paddingLeft: 2,
            gap: 2,
        })

        const config = loadConfig()
        const recentPaths = (config.recentScanPaths || [])
            .filter((p: string) => !shortcuts.some(sc => sc.path === p))
            .slice(0, 3)

        if (recentPaths.length > 0) {
            recentRow.height = 1
            recentRow.add(new TextRenderable(this.renderer, {
                id: "recent-label",
                content: t`${fg(theme.text.subtle)("Recent:")}`,
            }))
            for (let ri = 0; ri < recentPaths.length; ri++) {
                const key = `${ri + 4}`
                const rp = recentPaths[ri]!
                shortcuts.push({ key, path: rp, label: this.shortenPath(rp) })
                recentRow.add(new TextRenderable(this.renderer, {
                    id: `recent-${ri}`,
                    content: t`${fg(theme.accent.cyan)(key)} ${fg(theme.text.subtle)(truncate(this.shortenPath(rp), 25))}`,
                }))
            }
        }

        // ── Search row (hidden by default) ──
        this.searchRow = new BoxRenderable(this.renderer, {
            id: "import-search-row",
            width: "100%",
            height: 0,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: 2,
            paddingRight: 2,
            gap: 1,
        })

        const searchLabel = new TextRenderable(this.renderer, {
            id: "import-search-label",
            content: t`${fg(theme.accent.cyan)("🔍 Filter:")}`,
        })

        this.searchInput = new InputRenderable(this.renderer, {
            id: "import-search-input",
            width: 40,
            value: "",
            placeholder: "type to filter...",
            backgroundColor: theme.bg.card,
            focusedBackgroundColor: theme.bg.hover,
            textColor: theme.text.body,
            cursorColor: theme.accent.cyan,
        })

        this.searchRow.add(searchLabel)
        this.searchRow.add(this.searchInput)

        // ── File list ──
        this.fileList = new ScrollBoxRenderable(this.renderer, {
            id: "import-file-list",
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
                gap: 0,
                backgroundColor: theme.bg.void,
            },
        })

        // ── Status bar ──
        this.statusBar = new StatusBar({ renderer: this.renderer })
        this.hintText = new TextRenderable(this.renderer, {
            id: "import-hint",
            content: t`${fg(theme.text.subtle)("⏎ Scan · ↑↓ Select · Space Check · / Filter · p Preview · +/- Depth · s Sort · a Import All · q Back")}`,
        })
        this.statusBar.root.add(this.hintText)

        this.container.add(header)
        this.container.add(pathRow)
        this.container.add(quickPaths)
        this.container.add(recentRow)
        this.container.add(this.searchRow)
        this.container.add(this.fileList)
        this.renderer.root.add(this.container)
        this.renderer.root.add(this.statusBar.root)

        this.pathInput.focus()

        // ── Keybinds ──
        this.inputHandler = (sequence: string) => {
            // While importing, only allow cancel
            if (this.importing) {
                if (sequence === "\x1b") {
                    this.importCancelled = true
                    return true
                }
                return true
            }

            // Preview modal dismiss
            if (this.previewVisible) {
                if (sequence === "\x1b" || sequence === "p" || sequence === "q") {
                    this.closePreview()
                    return true
                }
                return true
            }

            // Search input mode
            if (this.searchActive && this.searchInput.focused) {
                if (sequence === "\x1b" || sequence === "\r" || sequence === "\n") {
                    this.searchInput.blur?.()
                    this.fileList.focus()
                    if (sequence === "\x1b" && this.searchInput.value === "") {
                        this.hideSearch()
                    }
                    return true
                }
                // Let input handle typing, then update filter
                setTimeout(() => {
                    if (this.searchInput.value !== this.searchQuery) {
                        this.searchQuery = this.searchInput.value
                        this.applyFilter()
                    }
                }, 0)
                return false
            }

            // Path input mode — supports direct file path import
            if (this.pathInput.focused) {
                if (sequence === "\r" || sequence === "\n") {
                    const inputVal = this.pathInput.value.trim()
                    // Check if path points to a single file
                    if (this.isBookFile(inputVal)) {
                        this.importDirectFile(inputVal)
                    } else {
                        this.scanDirectory(inputVal)
                    }
                    this.fileList.focus()
                    return true
                }
                if (sequence === "\x1b") {
                    this.fileList.focus()
                    return true
                }
                return false
            }

            // ── List mode keybinds ──
            switch (sequence) {
                case "j":
                case "\x1b[B":
                    this.moveSelection(1)
                    return true
                case "k":
                case "\x1b[A":
                    this.moveSelection(-1)
                    return true
                // Page navigation
                case "\x04": // Ctrl+d
                    this.moveSelection(10)
                    return true
                case "\x15": // Ctrl+u
                    this.moveSelection(-10)
                    return true
                case "g":
                    this.selectedIndex = 0
                    this.renderFileList()
                    this.fileList.scrollTo(0)
                    return true
                case "G":
                    this.selectedIndex = Math.max(0, this.filteredFiles.length - 1)
                    this.renderFileList()
                    this.fileList.scrollTo(this.selectedIndex * 3)
                    return true
                // Multi-select
                case " ":
                    this.toggleSelect()
                    return true
                // Import
                case "\r":
                case "\n":
                    this.importSelected()
                    return true
                case "a":
                    this.importAll()
                    return true
                // Search/filter
                case "/":
                    this.showSearch()
                    return true
                // Sort
                case "s":
                    this.cycleSort()
                    return true
                // Scan depth control
                case "+":
                case "=":
                    this.adjustScanDepth(1)
                    return true
                case "-":
                    this.adjustScanDepth(-1)
                    return true
                // Metadata preview
                case "p":
                    this.showPreview()
                    return true
                // Quick shortcuts (1-6 for paths)
                case "1":
                case "2":
                case "3":
                case "4":
                case "5":
                case "6": {
                    const sc = shortcuts.find(s => s.key === sequence)
                    if (sc) {
                        this.pathInput.value = sc.path
                        this.scanDirectory(sc.path)
                    }
                    return true
                }
                // Edit path
                case "e":
                    this.pathInput.focus()
                    return true
                case "q":
                    this.app.showLibrary()
                    return true
            }
            return false
        }
        this.renderer.addInputHandler(this.inputHandler)
    }

    // ── Header update ──
    private updateHeader() {
        if (this.files.length === 0) {
            this.headerText.content = t`${bold(fg(theme.accent.green)("📂 Import Books"))}`
            return
        }
        const epubs = this.files.filter(f => f.format === "epub").length
        const pdfs = this.files.filter(f => f.format === "pdf").length
        const mds = this.files.filter(f => f.format === "md").length
        const txts = this.files.filter(f => f.format === "txt").length
        const imported = this.files.filter(f => f.alreadyImported).length
        const checked = this.files.filter(f => f.selected).length
        const parts: string[] = []
        if (epubs > 0) parts.push(`${epubs} EPUB`)
        if (pdfs > 0) parts.push(`${pdfs} PDF`)
        if (mds > 0) parts.push(`${mds} MD`)
        if (txts > 0) parts.push(`${txts} TXT`)
        const sortLabel = this.sortMode === "name" ? "A-Z" : this.sortMode === "size" ? "Size" : "Format"

        // Build plain-text segments, then style them all in one t`` call
        const countStr = `${this.files.length} found (${parts.join(" · ")})`
        const importedStr = imported > 0 ? ` · ${imported} imported` : ""
        const checkedStr = checked > 0 ? ` · ${checked} selected` : ""
        const filterStr = this.searchQuery ? ` · filter: "${this.searchQuery}" → ${this.filteredFiles.length}` : ""
        const metaStr = ` · [s] ${sortLabel} · [±] depth ${this.scanDepth}`

        this.headerText.content = t`${bold(fg(theme.accent.green)("📂 Import Books"))}  ${fg(theme.text.muted)("─")}  ${fg(theme.text.body)(countStr + importedStr)}${checked > 0 ? fg(theme.accent.amber)(checkedStr) : ""}${this.searchQuery ? fg(theme.accent.cyan)(filterStr) : ""}${fg(theme.text.subtle)(metaStr)}`
    }

    // ── Search ──
    private showSearch() {
        this.searchActive = true
        this.searchRow.height = 3
        this.searchInput.focus()
    }

    private hideSearch() {
        this.searchActive = false
        this.searchQuery = ""
        this.searchInput.value = ""
        this.searchRow.height = 0
        this.applyFilter()
    }

    private applyFilter() {
        if (this.searchQuery.trim() === "") {
            this.filteredFiles = this.files.slice()
        } else {
            const q = this.searchQuery.toLowerCase()
            this.filteredFiles = this.files.filter(f =>
                f.name.toLowerCase().includes(q) ||
                f.dir.toLowerCase().includes(q) ||
                f.format.includes(q)
            )
        }
        this.applySorting()
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredFiles.length - 1))
        this.updateHeader()
        this.renderFileList()
    }

    // ── Sorting ──
    private cycleSort() {
        const modes: SortMode[] = ["name", "size", "format"]
        const idx = modes.indexOf(this.sortMode)
        this.sortMode = modes[(idx + 1) % modes.length]!
        this.applyFilter()
        showToast(this.renderer, `Sort: ${this.sortMode === "name" ? "A-Z" : this.sortMode === "size" ? "Size ↓" : "Format"}`, "info")
    }

    private applySorting() {
        switch (this.sortMode) {
            case "name":
                this.filteredFiles.sort((a, b) => a.name.localeCompare(b.name))
                break
            case "size":
                this.filteredFiles.sort((a, b) => b.sizeBytes - a.sizeBytes)
                break
            case "format":
                this.filteredFiles.sort((a, b) => a.format.localeCompare(b.format) || a.name.localeCompare(b.name))
                break
        }
    }

    // ── Multi-select ──
    private toggleSelect() {
        if (this.filteredFiles.length === 0) return
        const file = this.filteredFiles[this.selectedIndex]
        if (!file || file.alreadyImported) return
        file.selected = !file.selected
        this.moveSelection(1)
        this.updateHeader()
    }

    // ── Async streaming scan — files appear live as discovered ──
    private async scanDirectory(dirPath: string) {
        if (this.scanning) return
        this.files = []
        this.filteredFiles = []
        this.selectedIndex = 0
        this.scanning = true
        this.scanPath = dirPath

        // Track recent scan paths
        this.recordRecentPath(dirPath)

        // Clear existing list
        for (const card of this.cardRenderables) {
            try { this.fileList.remove(card.id) } catch { }
        }
        this.cardRenderables = []

        // Show spinner at top of list
        const loadingText = new TextRenderable(this.renderer, {
            id: "import-loading",
            content: t`${fg(theme.accent.cyan)("⠋")} Scanning...`,
        })
        this.fileList.add(loadingText)

        // Spinner animation
        let frame = 0
        const spinnerInterval = setInterval(() => {
            frame = (frame + 1) % spinnerFrames.length
            loadingText.content = t`${fg(theme.accent.cyan)(spinnerFrames[frame]!)} Scanning ${truncate(dirPath, 40)} (depth ${this.scanDepth})... ${fg(theme.text.muted)(`${this.files.length} files found`)}`
        }, 80)

        // Throttled live re-render: refresh the list every 300ms while scanning
        let lastRenderedCount = 0
        const liveRenderInterval = setInterval(() => {
            if (this.files.length > lastRenderedCount) {
                lastRenderedCount = this.files.length
                this.filteredFiles = this.files.slice()
                this.applySorting()
                this.updateHeader()
                this.renderFileList()
            }
        }, 300)

        try {
            await this.walkDirAsync(dirPath, this.scanDepth)
        } catch (err) {
            showToast(this.renderer, `Scan failed: ${err}`, "error")
        }

        clearInterval(spinnerInterval)
        clearInterval(liveRenderInterval)
        try { this.fileList.remove(loadingText.id) } catch { }
        this.scanning = false

        // Final render with complete results
        this.filteredFiles = this.files.slice()
        this.applySorting()
        this.updateHeader()

        if (this.files.length === 0) {
            this.renderEmptyState(dirPath)
        } else {
            const epubs = this.files.filter(f => f.format === "epub").length
            const pdfs = this.files.filter(f => f.format === "pdf").length
            const mds = this.files.filter(f => f.format === "md").length
            const txts = this.files.filter(f => f.format === "txt").length
            const parts = []
            if (epubs > 0) parts.push(`${epubs} EPUB`)
            if (pdfs > 0) parts.push(`${pdfs} PDF`)
            if (mds > 0) parts.push(`${mds} MD`)
            if (txts > 0) parts.push(`${txts} TXT`)
            showToast(this.renderer, `Found ${parts.join(" + ")} — scan complete`, "success")
            this.renderFileList()
        }
    }

    private async walkDirAsync(dir: string, maxDepth: number, depth = 0) {
        if (depth > maxDepth) return
        try {
            const entries = await readdir(dir)
            for (const entry of entries) {
                if (entry.startsWith(".")) continue
                const fullPath = join(dir, entry)
                try {
                    const s = await stat(fullPath)
                    if (s.isDirectory()) {
                        await this.walkDirAsync(fullPath, maxDepth, depth + 1)
                    } else {
                        const ext = extname(entry).toLowerCase()
                        if (ext === ".epub" || ext === ".pdf" || ext === ".md" || ext === ".txt") {
                            const format = ext.slice(1) as "epub" | "pdf" | "md" | "txt"
                            const sizeMB = (s.size / (1024 * 1024)).toFixed(1)
                            const alreadyImported = !!getBookByPath(fullPath)
                            const relDir = this.shortenPath(dirname(fullPath))
                            this.files.push({
                                name: basename(entry, ext),
                                path: fullPath,
                                dir: relDir,
                                sizeBytes: s.size,
                                size: `${sizeMB}MB`,
                                format,
                                alreadyImported,
                                selected: false,
                            })
                        }
                    }
                } catch { }
            }
        } catch { }
    }

    private shortenPath(dir: string): string {
        const home = homedir()
        if (dir.startsWith(home)) {
            return "~" + dir.slice(home.length)
        }
        return dir
    }

    // ── Empty state (P2) ──
    private renderEmptyState(dirPath: string) {
        for (const card of this.cardRenderables) {
            try { this.fileList.remove(card.id) } catch { }
        }
        this.cardRenderables = []

        const emptyBox = new BoxRenderable(this.renderer, {
            id: "import-empty",
            width: "100%",
            height: 12,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            paddingTop: 2,
            paddingLeft: 4,
            gap: 1,
        })

        const lines = [
            { id: "empty-1", text: t`${fg(theme.text.muted)("📭  No EPUB, PDF, MD, or TXT files found")}` },
            { id: "empty-2", text: t`${fg(theme.text.subtle)(`in ${truncate(this.shortenPath(dirPath), 50)}`)}` },
            { id: "empty-3", text: " " },
            { id: "empty-4", text: t`${fg(theme.text.muted)("Try:")}` },
            { id: "empty-5", text: t`  ${fg(theme.accent.cyan)("e")}  ${fg(theme.text.body)("Edit the scan path")}` },
            { id: "empty-6", text: t`  ${fg(theme.accent.cyan)("1")}  ${fg(theme.text.body)("Scan ~ Home")}` },
            { id: "empty-7", text: t`  ${fg(theme.accent.cyan)("2")}  ${fg(theme.text.body)("Scan ~/Documents")}` },
            { id: "empty-8", text: t`  ${fg(theme.accent.cyan)("3")}  ${fg(theme.text.body)("Scan ~/Downloads")}` },
        ]

        for (const line of lines) {
            emptyBox.add(new TextRenderable(this.renderer, { id: line.id, content: line.text }))
        }

        this.fileList.add(emptyBox)
        this.cardRenderables.push(emptyBox)
    }

    // ── File list rendering ──
    private renderFileList() {
        for (const card of this.cardRenderables) {
            try { this.fileList.remove(card.id) } catch { }
        }
        this.cardRenderables = []

        if (this.filteredFiles.length === 0) {
            if (!this.scanning) {
                this.renderEmptyState(this.scanPath || this.pathInput.value || homedir())
            }
            return
        }

        for (let i = 0; i < this.filteredFiles.length; i++) {
            const file = this.filteredFiles[i]!
            const isSelected = i === this.selectedIndex

            const row = new BoxRenderable(this.renderer, {
                id: `file-row-${i}`,
                width: "100%",
                height: 2,
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: 2,
                gap: 2,
                backgroundColor: isSelected ? theme.bg.hover : "transparent",
            })

            const cursor = isSelected ? fg(theme.accent.green)("▸") : " "
            const check = file.alreadyImported
                ? fg(theme.text.subtle)("✓")
                : file.selected
                    ? fg(theme.accent.amber)("◉")
                    : fg(theme.text.subtle)("○")
            const formatColor = file.format === "pdf"
                ? theme.accent.orange
                : file.format === "epub"
                    ? theme.accent.purple
                    : theme.accent.cyan

            row.add(new TextRenderable(this.renderer, {
                id: `file-cur-${i}`,
                content: t`${cursor}`,
            }))
            row.add(new TextRenderable(this.renderer, {
                id: `file-chk-${i}`,
                content: t`${check}`,
            }))
            row.add(new TextRenderable(this.renderer, {
                id: `file-fmt-${i}`,
                content: t`${fg(formatColor)(file.format.toUpperCase())}`,
            }))
            row.add(new TextRenderable(this.renderer, {
                id: `file-name-${i}`,
                content: t`${fg(file.alreadyImported ? theme.text.subtle : isSelected ? theme.accent.green : theme.text.body)(truncate(file.name, 45))}`,
            }))
            row.add(new TextRenderable(this.renderer, {
                id: `file-size-${i}`,
                content: t`${fg(theme.text.subtle)(file.size)}${file.alreadyImported ? fg(theme.text.subtle)(" imported") : ""}`,
            }))

            this.fileList.add(row)
            this.cardRenderables.push(row)
        }
    }

    private moveSelection(delta: number) {
        if (this.filteredFiles.length === 0) return
        this.selectedIndex = Math.max(0, Math.min(this.filteredFiles.length - 1, this.selectedIndex + delta))
        this.renderFileList()

        // Scroll to keep selected item visible (each row is 3 lines tall)
        const targetLine = this.selectedIndex * 3
        this.fileList.scrollTo(targetLine)
    }

    // ── Import logic ──
    private async importSelected() {
        if (this.filteredFiles.length === 0) return

        // If any files are checked, import all checked ones
        const checked = this.filteredFiles.filter(f => f.selected && !f.alreadyImported)
        if (checked.length > 0) {
            await this.importBatch(checked)
            return
        }

        // Otherwise import the one under the cursor
        const file = this.filteredFiles[this.selectedIndex]
        if (!file) return
        if (file.alreadyImported) {
            showToast(this.renderer, "Already imported", "info")
            return
        }
        await this.importFile(file)
    }

    private async importAll() {
        const toImport = this.filteredFiles.filter(f => !f.alreadyImported)
        if (toImport.length === 0) {
            showToast(this.renderer, "All files already imported", "info")
            return
        }
        await this.importBatch(toImport)
    }

    private async importBatch(files: FoundFile[]) {
        this.importing = true
        this.importCancelled = false
        const total = files.length

        // Show progress in status bar
        let imported = 0
        let failed = 0

        for (const file of files) {
            if (this.importCancelled) {
                showToast(this.renderer, `Cancelled — imported ${imported}/${total}`, "info")
                break
            }

            // Update status bar with progress
            const pct = Math.round(((imported + failed) / total) * 100)
            const bar = progressBar(pct, 20)
            this.hintText.content = t`${fg(theme.accent.cyan)("Importing")} ${fg(theme.text.body)(`${imported + failed + 1}/${total}`)} ${fg(progressColor(pct))(bar)} ${fg(theme.text.muted)(truncate(file.name, 25))} ${fg(theme.text.subtle)("Esc to cancel")}`

            try {
                const parsed = file.format === "pdf"
                    ? await parsePdf(file.path)
                    : file.format === "epub"
                        ? await parseEpub(file.path)
                        : await (await import("../services/md-parser")).parseMd(file.path)
                insertBook({
                    title: parsed.metadata.title,
                    author: parsed.metadata.author,
                    path: file.path,
                    format: file.format,
                    total_chapters: parsed.chapters.length,
                })
                file.alreadyImported = true
                file.selected = false
                imported++
            } catch (err) {
                failed++
            }
        }

        this.importing = false

        // Restore status bar
        this.hintText.content = t`${fg(theme.text.subtle)("⏎ Scan · ↑↓ Select · Space Check · / Filter · p Preview · +/- Depth · s Sort · a Import All · q Back")}`

        if (!this.importCancelled) {
            const msg = failed > 0
                ? `Imported ${imported}, ${failed} failed`
                : `Imported ${imported} book(s)`
            showToast(this.renderer, `✓ ${msg}`, imported > 0 ? "success" : "error")
        }

        this.updateHeader()
        this.renderFileList()
    }

    // ── Single file import ──
    private async importFile(file: FoundFile) {
        try {
            const parsed = file.format === "pdf"
                ? await parsePdf(file.path)
                : await parseEpub(file.path)
            insertBook({
                title: parsed.metadata.title,
                author: parsed.metadata.author,
                path: file.path,
                format: file.format,
                total_chapters: parsed.chapters.length,
            })
            file.alreadyImported = true
            file.selected = false
            this.updateHeader()
            this.renderFileList()
            showToast(this.renderer, `✓ Imported: ${truncate(file.name, 30)}`, "success")
        } catch (err) {
            showToast(this.renderer, `Failed: ${file.name}`, "error")
        }
    }

    // ── Scan depth control (P2) ──
    private adjustScanDepth(delta: number) {
        const newDepth = Math.max(1, Math.min(8, this.scanDepth + delta))
        if (newDepth === this.scanDepth) return
        this.scanDepth = newDepth
        updateConfig("scanDepth", newDepth)
        this.updateHeader()
        showToast(this.renderer, `Scan depth: ${this.scanDepth} (rescan to apply)`, "info")
    }

    // ── Recent paths (P3) ──
    private recordRecentPath(dirPath: string) {
        const config = loadConfig()
        const recent = config.recentScanPaths.filter(p => p !== dirPath)
        recent.unshift(dirPath)
        updateConfig("recentScanPaths", recent.slice(0, 10))
    }

    // ── Direct file import (P3) ──
    private isBookFile(path: string): boolean {
        const ext = extname(path).toLowerCase()
        if (ext !== ".epub" && ext !== ".pdf") return false
        try {
            return existsSync(path) && statSync(path).isFile()
        } catch { return false }
    }

    private async importDirectFile(filePath: string) {
        const ext = extname(filePath).toLowerCase()
        const format = ext === ".epub" ? "epub" : "pdf" as const
        const name = basename(filePath, ext)

        // Check if already imported
        if (getBookByPath(filePath)) {
            showToast(this.renderer, `"${truncate(name, 30)}" is already in library`, "info")
            return
        }

        // Check for title+author duplicate
        showToast(this.renderer, `Importing ${truncate(name, 30)}...`, "info")

        try {
            const parsed = format === "pdf"
                ? await parsePdf(filePath)
                : await parseEpub(filePath)

            if (this.isDuplicate(parsed.metadata.title, parsed.metadata.author)) {
                showToast(this.renderer, `Possible duplicate: "${truncate(parsed.metadata.title, 25)}" by ${parsed.metadata.author}`, "info")
            }

            insertBook({
                title: parsed.metadata.title,
                author: parsed.metadata.author,
                path: filePath,
                format,
                total_chapters: parsed.chapters.length,
            })
            showToast(this.renderer, `✓ Imported: ${truncate(name, 30)}`, "success")
        } catch (err) {
            showToast(this.renderer, `Failed to import: ${name}`, "error")
        }
    }

    // ── Duplicate detection by title+author (P3) ──
    private isDuplicate(title: string, author: string): boolean {
        const { getAllBooks } = require("../services/database")
        const books = getAllBooks() as { title: string; author: string }[]
        const normTitle = title.toLowerCase().trim()
        const normAuthor = author.toLowerCase().trim()
        return books.some(b =>
            b.title.toLowerCase().trim() === normTitle &&
            b.author.toLowerCase().trim() === normAuthor
        )
    }

    // ── Metadata preview (P3) ──
    private async showPreview() {
        if (this.filteredFiles.length === 0) return
        const file = this.filteredFiles[this.selectedIndex]
        if (!file) return

        this.previewVisible = true

        // Create preview overlay
        this.previewBox = new BoxRenderable(this.renderer, {
            id: "import-preview",
            width: "80%",
            height: 16,
            flexDirection: "column",
            padding: 2,
            backgroundColor: theme.bg.card,
            borderStyle: "single",
            borderColor: theme.accent.purple,
        })

        const previewTitle = new TextRenderable(this.renderer, {
            id: "preview-title",
            content: t`${bold(fg(theme.accent.purple)("📋 Metadata Preview"))}  ${fg(theme.text.subtle)("Press Esc/p to close")}`,
        })
        this.previewBox.add(previewTitle)

        const loadingPreview = new TextRenderable(this.renderer, {
            id: "preview-loading",
            content: t`${fg(theme.accent.cyan)("⠋")} Parsing ${truncate(file.name, 40)}...`,
        })
        this.previewBox.add(loadingPreview)
        this.renderer.root.add(this.previewBox)

        try {
            const parsed = file.format === "pdf"
                ? await parsePdf(file.path)
                : await parseEpub(file.path)

            try { this.previewBox.remove("preview-loading") } catch { }

            const meta = parsed.metadata
            const totalWords = parsed.chapters.reduce((sum: number, ch: { wordCount: number }) => sum + ch.wordCount, 0)
            const isDup = this.isDuplicate(meta.title, meta.author)

            const lines = [
                { id: "pv-sep", text: t`${fg(theme.border.normal)("─".repeat(50))}` },
                { id: "pv-title", text: t`  ${fg(theme.text.muted)("Title:")}     ${fg(theme.text.bright)(meta.title)}` },
                { id: "pv-author", text: t`  ${fg(theme.text.muted)("Author:")}    ${fg(theme.text.body)(meta.author)}` },
                { id: "pv-format", text: t`  ${fg(theme.text.muted)("Format:")}    ${fg(file.format === "pdf" ? theme.accent.orange : theme.accent.purple)(file.format.toUpperCase())}  ${fg(theme.text.subtle)(file.size)}` },
                { id: "pv-chaps", text: t`  ${fg(theme.text.muted)("Chapters:")}  ${fg(theme.accent.blue)(`${parsed.chapters.length}`)}` },
                { id: "pv-words", text: t`  ${fg(theme.text.muted)("Words:")}     ${fg(theme.accent.cyan)(`~${(totalWords / 1000).toFixed(1)}k`)}` },
            ]

            if (meta.publisher) {
                lines.push({ id: "pv-pub", text: t`  ${fg(theme.text.muted)("Publisher:")} ${fg(theme.text.body)(meta.publisher)}` })
            }
            if (meta.language) {
                lines.push({ id: "pv-lang", text: t`  ${fg(theme.text.muted)("Language:")}  ${fg(theme.text.body)(meta.language)}` })
            }
            if (isDup) {
                lines.push({ id: "pv-dup", text: t`  ${fg(theme.accent.amber)("⚠ Possible duplicate in library")}` })
            }
            if (file.alreadyImported) {
                lines.push({ id: "pv-imp", text: t`  ${fg(theme.accent.green)("✓ Already imported")}` })
            }

            // Show first 3 chapter titles
            lines.push({ id: "pv-sep2", text: t`${fg(theme.border.normal)("─".repeat(50))}` })
            const chapterPreview = parsed.chapters.slice(0, 3)
            for (let i = 0; i < chapterPreview.length; i++) {
                const ch = chapterPreview[i]!
                lines.push({
                    id: `pv-ch-${i}`,
                    text: t`  ${fg(theme.text.subtle)(`${i + 1}.`)} ${fg(theme.text.body)(truncate(ch.title, 45))} ${fg(theme.text.subtle)(`(${ch.wordCount} words)`)}`,
                })
            }
            if (parsed.chapters.length > 3) {
                lines.push({ id: "pv-more", text: t`  ${fg(theme.text.subtle)(`... and ${parsed.chapters.length - 3} more chapters`)}` })
            }

            for (const line of lines) {
                this.previewBox.add(new TextRenderable(this.renderer, { id: line.id, content: line.text }))
            }

            // Resize to fit content
            this.previewBox.height = Math.min(24, lines.length + 4)
        } catch (err) {
            try { this.previewBox.remove("preview-loading") } catch { }
            this.previewBox.add(new TextRenderable(this.renderer, {
                id: "preview-error",
                content: t`${fg(theme.accent.pink)("✗ Failed to parse file metadata")}`,
            }))
        }
    }

    private closePreview() {
        this.previewVisible = false
        if (this.previewBox) {
            try { this.renderer.root.remove(this.previewBox.id) } catch { }
            this.previewBox = null
        }
    }

    destroy() {
        this.closePreview()
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
        }
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
