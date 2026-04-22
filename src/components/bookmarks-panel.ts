// ─────────────────────────────────────────────────────────────
// Bookmarks Panel — view and jump to saved bookmarks
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, SelectRenderable, SelectRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme, relativeTime } from "../utils/theme"
import { getBookmarks, removeBookmark, type BookmarkRecord } from "../services/database"

export class BookmarksPanel {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private select!: SelectRenderable
    private visible = false
    private bookmarks: BookmarkRecord[] = []
    private bookId: number
    private onSelect: (chapter: number, scrollPos: number) => void
    private onClose: () => void

    constructor(
        renderer: CliRenderer,
        bookId: number,
        onSelect: (chapter: number, scrollPos: number) => void,
        onClose: () => void,
    ) {
        this.renderer = renderer
        this.bookId = bookId
        this.onSelect = onSelect
        this.onClose = onClose
    }

    show() {
        if (this.visible) return
        this.visible = true
        this.bookmarks = getBookmarks(this.bookId)

        this.container = new BoxRenderable(this.renderer, {
            id: "bookmarks-overlay",
            position: "absolute",
            top: 3,
            bottom: 3,
            left: "20%",
            right: "20%",
            borderStyle: "rounded",
            borderColor: theme.accent.amber,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 0,
        })

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "bookmarks-title",
            content: t` ${bold(fg(theme.accent.amber)("🔖 Bookmarks"))}  ${fg(theme.text.subtle)(`(${this.bookmarks.length})`)}`,
        }))

        this.container.add(new TextRenderable(this.renderer, {
            id: "bookmarks-sep",
            content: " " + "━".repeat(36),
            fg: theme.border.normal,
        }))

        if (this.bookmarks.length === 0) {
            this.container.add(new TextRenderable(this.renderer, {
                id: "bookmarks-empty",
                content: t`\n  ${fg(theme.text.subtle)("No bookmarks yet — press b in the reader to add one")}`,
            }))
        } else {
            const options = this.bookmarks.map((bm, i) => {
                const label = bm.label || `Chapter ${bm.chapter + 1}, pos ${bm.scroll_position}`
                return {
                    name: `🔖 ${label}`,
                    description: relativeTime(bm.created_at),
                    value: i.toString(),
                }
            })

            this.select = new SelectRenderable(this.renderer, {
                id: "bookmarks-select",
                width: "100%",
                height: Math.min(this.bookmarks.length * 2 + 2, 20),
                options,
                backgroundColor: "transparent",
                selectedBackgroundColor: theme.bg.hover,
                selectedTextColor: theme.accent.amber,
                textColor: theme.text.body,
                descriptionColor: theme.text.subtle,
                selectedDescriptionColor: theme.text.muted,
                showDescription: true,
            })

            this.select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: any) => {
                const bm = this.bookmarks[parseInt(option.value)]
                if (bm) {
                    this.hide()
                    this.onSelect(bm.chapter, bm.scroll_position)
                }
            })

            this.container.add(this.select)
            this.select.focus()
        }

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "bookmarks-footer",
            content: t`\n${fg(theme.text.subtle)(" ↑↓ Navigate · ⏎ Jump to · d Delete · q/Esc Close")}`,
        }))

        this.renderer.root.add(this.container)

        // Input handler
        this.renderer.addInputHandler((seq: string) => {
            if (!this.visible) return false
            if (seq === "q" || seq === "\x1b" || seq === "B") {
                this.hide()
                return true
            }
            if (seq === "d" && this.bookmarks.length > 0 && this.select) {
                // Delete currently selected bookmark
                const idx = this.select.selectedIndex
                const bm = this.bookmarks[idx]
                if (bm) {
                    removeBookmark(bm.id)
                    // Refresh
                    this.hide()
                    this.show()
                }
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
