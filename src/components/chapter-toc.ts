// ─────────────────────────────────────────────────────────────
// Chapter TOC Modal — quick chapter navigation overlay
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, SelectRenderable, SelectRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import { enableSelectTap, enableTap } from "../utils/touch"
import type { Chapter } from "../services/epub-parser"

export class ChapterTocModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private select!: SelectRenderable
    private visible = false
    private onSelect: (chapterIndex: number) => void
    private onClose: () => void
    private inputHandler: ((seq: string) => boolean) | null = null

    constructor(
        renderer: CliRenderer,
        onSelect: (chapterIndex: number) => void,
        onClose: () => void,
    ) {
        this.renderer = renderer
        this.onSelect = onSelect
        this.onClose = onClose
    }

    show(chapters: Chapter[], currentChapter: number, completedChapters: Set<number> = new Set()) {
        if (this.visible) return
        this.visible = true

        // Full-screen backdrop: tap outside the modal to close (touch).
        const backdrop = new BoxRenderable(this.renderer, {
            id: "toc-backdrop",
            position: "absolute",
            top: 0, bottom: 0, left: 0, right: 0,
            backgroundColor: "transparent",
        })
        enableTap(backdrop, () => this.hide())
        this.renderer.root.add(backdrop)

        this.container = new BoxRenderable(this.renderer, {
            id: "toc-overlay",
            position: "absolute",
            top: 3,
            bottom: 3,
            left: "20%",
            right: "20%",
            borderStyle: "rounded",
            borderColor: theme.accent.purple,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 0,
        })

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "toc-title",
            content: t` ${bold(fg(theme.accent.purple)("📑 Chapters"))}  ${fg(theme.text.subtle)(`(${chapters.length} total)`)}`,
        }))

        this.container.add(new TextRenderable(this.renderer, {
            id: "toc-sep",
            content: " " + "━".repeat(36),
            fg: theme.border.normal,
        }))

        // Build options
        const options = chapters.map((ch, i) => {
            const isCompleted = completedChapters.has(i)
            const num = (i + 1).toString().padStart(3, " ")
            const indicator = i === currentChapter ? "▸ " : isCompleted ? "✓ " : "  "
            const wordInfo = ch.wordCount > 0 ? `${(ch.wordCount / 1000).toFixed(1)}k words` : ""
            return {
                name: `${indicator}${num}. ${truncate(ch.title, 35)}`,
                description: wordInfo,
                value: i.toString(),
            }
        })

        const maxHeight = Math.min(chapters.length * 2 + 2, (process.stdout.rows || 40) - 10)

        this.select = new SelectRenderable(this.renderer, {
            id: "toc-select",
            width: "100%",
            height: Math.max(10, maxHeight),
            options,
            selectedIndex: currentChapter,
            backgroundColor: "transparent",
            selectedBackgroundColor: theme.bg.hover,
            selectedTextColor: theme.accent.blue,
            textColor: theme.text.body,
            descriptionColor: theme.text.subtle,
            selectedDescriptionColor: theme.text.muted,
            showDescription: true,
        })

        this.select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: any) => {
            const chapterIndex = parseInt(option.value)
            this.hide()
            this.onSelect(chapterIndex)
        })

        this.container.add(this.select)

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "toc-footer",
            content: t`${fg(theme.text.subtle)(" ↑↓ Navigate · ⏎ Go to · q/Esc Close")}`,
        }))

        this.renderer.root.add(this.container)
        this.select.focus()

        // Touch: tap a chapter to jump to it; tap the backdrop to close.
        enableSelectTap(this.select)

        // Input handler for closing
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false
            if (seq === "q" || seq === "\x1b" || seq === "t") {
                this.hide()
                return true
            }
            return false
        }
        this.renderer.addInputHandler(this.inputHandler)
    }

    hide() {
        if (!this.visible) return
        this.visible = false
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
            this.inputHandler = null
        }
        try { this.renderer.root.remove("toc-backdrop") } catch { }
        try { this.renderer.root.remove(this.container.id) } catch { }
        this.onClose()
    }

    destroy() {
        this.hide()
    }
}
