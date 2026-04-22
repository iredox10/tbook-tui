// ─────────────────────────────────────────────────────────────
// Import View — scan filesystem for EPUB & PDF files and import
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    InputRenderable, InputRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, truncate, spinnerFrames } from "../utils/theme"
import { insertBook, getBookByPath } from "../services/database"
import { parseEpub } from "../services/epub-parser"
import { parsePdf, hasPdfSupport } from "../services/pdf-parser"
import { StatusBar } from "../components/status-bar"
import { showToast } from "../components/toast"
import type { App } from "../app"
import { readdirSync, statSync } from "fs"
import { join, extname, basename } from "path"
import { homedir } from "os"

interface FoundFile {
    name: string
    path: string
    size: string
    format: "epub" | "pdf"
    alreadyImported: boolean
}

export class ImportView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private fileList!: ScrollBoxRenderable
    private statusBar!: StatusBar
    private pathInput!: InputRenderable
    private files: FoundFile[] = []
    private selectedIndex = 0
    private scanning = false
    private cardRenderables: BoxRenderable[] = []

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

        const title = new TextRenderable(this.renderer, {
            id: "import-title",
            content: t`${bold(fg(theme.accent.green)("📂 Import Books"))}`,
        })
        header.add(title)

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
        // Override the right text with import-specific hints
        const importHint = new TextRenderable(this.renderer, {
            id: "import-hint",
            content: t`${fg(theme.text.subtle)("⏎ Scan · ↑↓ Select · a Import All · ⏎ Import Selected · q Back")}`,
        })
        this.statusBar.root.add(importHint)

        this.container.add(header)
        this.container.add(pathRow)
        this.container.add(quickPaths)
        this.container.add(this.fileList)
        this.renderer.root.add(this.container)
        this.renderer.root.add(this.statusBar.root)

        this.pathInput.focus()

        // ── Keybinds ──
        this.renderer.addInputHandler((sequence: string) => {
            if (this.pathInput.focused) {
                if (sequence === "\r" || sequence === "\n") {
                    this.scanDirectory(this.pathInput.value)
                    this.fileList.focus()
                    return true
                }
                // Quick shortcuts
                for (const sc of shortcuts) {
                    if (sequence === sc.key && !this.pathInput.focused) {
                        this.pathInput.value = sc.path
                        this.scanDirectory(sc.path)
                        return true
                    }
                }
                if (sequence === "\x1b") {
                    this.fileList.focus()
                    return true
                }
                return false
            }

            switch (sequence) {
                case "j":
                case "\x1b[B":
                    this.moveSelection(1)
                    return true
                case "k":
                case "\x1b[A":
                    this.moveSelection(-1)
                    return true
                case "\r":
                case "\n":
                    this.importSelected()
                    return true
                case "a":
                    this.importAll()
                    return true
                case "/":
                    this.pathInput.focus()
                    return true
                case "q":
                    this.app.showLibrary()
                    return true
            }
            return false
        })
    }

    private async scanDirectory(dirPath: string) {
        this.files = []
        this.selectedIndex = 0
        this.scanning = true

        // Show loading
        const loadingText = new TextRenderable(this.renderer, {
            id: "import-loading",
            content: t`${fg(theme.accent.cyan)("⠋")} Scanning...`,
        })
        this.fileList.add(loadingText)

        let frame = 0
        const spinnerInterval = setInterval(() => {
            frame = (frame + 1) % spinnerFrames.length
            loadingText.content = t`${fg(theme.accent.cyan)(spinnerFrames[frame]!)} Scanning ${truncate(dirPath, 40)}...`
        }, 80)

        try {
            this.walkDir(dirPath, 3) // max depth 3
        } catch (err) {
            showToast(this.renderer, `Scan failed: ${err}`, "error")
        }

        clearInterval(spinnerInterval)
        try { this.fileList.remove(loadingText.id) } catch { }
        this.scanning = false

        if (this.files.length === 0) {
            showToast(this.renderer, "No EPUB/PDF files found", "info")
        } else {
            const epubs = this.files.filter(f => f.format === "epub").length
            const pdfs = this.files.filter(f => f.format === "pdf").length
            const parts = []
            if (epubs > 0) parts.push(`${epubs} EPUB`)
            if (pdfs > 0) parts.push(`${pdfs} PDF`)
            showToast(this.renderer, `Found ${parts.join(" + ")}`, "success")
        }

        this.renderFileList()
    }

    private walkDir(dir: string, maxDepth: number, depth = 0) {
        if (depth > maxDepth) return
        try {
            const entries = readdirSync(dir)
            for (const entry of entries) {
                if (entry.startsWith(".")) continue
                const fullPath = join(dir, entry)
                try {
                    const stat = statSync(fullPath)
                    if (stat.isDirectory()) {
                        this.walkDir(fullPath, maxDepth, depth + 1)
                    } else {
                        const ext = extname(entry).toLowerCase()
                        if (ext === ".epub" || ext === ".pdf") {
                            const format = ext === ".epub" ? "epub" : "pdf" as const
                            const sizeMB = (stat.size / (1024 * 1024)).toFixed(1)
                            const alreadyImported = !!getBookByPath(fullPath)
                            this.files.push({
                                name: basename(entry, ext),
                                path: fullPath,
                                size: `${sizeMB}MB`,
                                format,
                                alreadyImported,
                            })
                        }
                    }
                } catch { }
            }
        } catch { }
    }

    private renderFileList() {
        for (const card of this.cardRenderables) {
            try { this.fileList.remove(card.id) } catch { }
        }
        this.cardRenderables = []

        for (let i = 0; i < this.files.length; i++) {
            const file = this.files[i]!
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

            const indicator = new TextRenderable(this.renderer, {
                id: `file-ind-${i}`,
                content: isSelected ? t`${fg(theme.accent.green)("▸")}` : " ",
            })

            const formatBadge = new TextRenderable(this.renderer, {
                id: `file-fmt-${i}`,
                content: t`${fg(file!.format === "pdf" ? theme.accent.orange : theme.accent.purple)(file!.format.toUpperCase())}`,
            })

            const name = new TextRenderable(this.renderer, {
                id: `file-name-${i}`,
                content: t`${fg(file.alreadyImported
                    ? theme.text.subtle
                    : isSelected ? theme.accent.green : theme.text.body
                )(truncate(file.name, 40))}`,
            })

            const meta = new TextRenderable(this.renderer, {
                id: `file-meta-${i}`,
                content: t`${fg(theme.text.subtle)(file.size)}${file.alreadyImported
                    ? fg(theme.text.subtle)(" ✓ imported")
                    : ""}`,
            })

            row.add(indicator)
            row.add(formatBadge)
            row.add(name)
            row.add(meta)
            this.fileList.add(row)
            this.cardRenderables.push(row)
        }
    }

    private moveSelection(delta: number) {
        if (this.files.length === 0) return
        this.selectedIndex = Math.max(0, Math.min(this.files.length - 1, this.selectedIndex + delta))
        this.renderFileList()

        // Scroll to keep selected item visible (each row is 2 lines tall)
        const targetLine = this.selectedIndex * 2
        this.fileList.scrollTo(targetLine)
    }

    private async importSelected() {
        if (this.files.length === 0) return
        const file = this.files[this.selectedIndex]
        if (!file) return
        if (file.alreadyImported) {
            showToast(this.renderer, "Already imported", "info")
            return
        }
        await this.importFile(file)
    }

    private async importAll() {
        const toImport = this.files.filter(f => !f.alreadyImported)
        if (toImport.length === 0) {
            showToast(this.renderer, "All files already imported", "info")
            return
        }
        for (const file of toImport) {
            await this.importFile(file)
        }
        showToast(this.renderer, `Imported ${toImport.length} book(s)`, "success")
    }

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
            this.renderFileList()
            showToast(this.renderer, `✓ Imported: ${truncate(file.name, 30)}`, "success")
        } catch (err) {
            showToast(this.renderer, `Failed: ${file.name}`, "error")
        }
    }

    destroy() {
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
