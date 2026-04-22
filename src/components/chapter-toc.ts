// ─────────────────────────────────────────────────────────────
// Chapter TOC Modal — quick chapter navigation overlay
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, SelectRenderable, SelectRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import type { Chapter } from "../services/epub-parser"

export class ChapterTocModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private select!: SelectRenderable
    private visible = false
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

    show(chapters: Chapter[], currentChapter: number) {
        if (this.visible) return
        this.visible = true

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
            const num = (i + 1).toString().padStart(3, " ")
            const indicator = i === currentChapter ? "▸ " : "  "
            const wordInfo = ch.wordCount > 0 ? `${(ch.wordCount / 1000).toFixed(1)}k words` : ""
            return {
                name: `${indicator}${num}. ${truncate(ch.title, 30)}`,
                description: wordInfo,
                value: i.toString(),
            }
        })

        this.select = new SelectRenderable(this.renderer, {
            id: "toc-select",
            width: "100%",
            height: Math.min(chapters.length * 2 + 2, 30),
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

        // Input handler for closing
        this.renderer.addInputHandler((seq: string) => {
            if (!this.visible) return false
            if (seq === "q" || seq === "\x1b" || seq === "t") {
                this.hide()
                return true
            }
            return false
        })
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
