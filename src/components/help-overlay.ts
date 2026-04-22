// ─────────────────────────────────────────────────────────────
// Help Overlay — modal keybind reference
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import { BoxRenderable, TextRenderable, t, bold, fg } from "@opentui/core"
import { theme } from "../utils/theme"

export class HelpOverlay {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private visible = false
    private onClose: () => void

    constructor(renderer: CliRenderer, onClose: () => void) {
        this.renderer = renderer
        this.onClose = onClose
    }

    show() {
        if (this.visible) return
        this.visible = true

        this.container = new BoxRenderable(this.renderer, {
            id: "help-overlay",
            position: "absolute",
            top: 2,
            bottom: 2,
            left: "15%",
            right: "15%",
            borderStyle: "rounded",
            borderColor: theme.accent.cyan,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 2,
            gap: 1,
        })

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "help-title",
            content: t`${bold(fg(theme.accent.cyan)("⌨  Keyboard Shortcuts"))}`,
        }))

        this.container.add(new TextRenderable(this.renderer, {
            id: "help-sep",
            content: "━".repeat(40),
            fg: theme.border.normal,
        }))

        // Sections
        const sections: { title: string; keys: [string, string][] }[] = [
            {
                title: "📖 Reader",
                keys: [
                    ["j / k / ↑ / ↓", "Scroll up / down"],
                    ["Space", "Page down"],
                    ["g / G", "Jump to top / bottom"],
                    ["h / l / ← / →", "Previous / next chapter"],
                    ["+ / -", "Zoom text wider / narrower"],
                    ["a", "Toggle auto-scroll"],
                    ["A", "Cycle auto-scroll speed"],
                    ["Tab", "Toggle chapter sidebar"],
                    ["T", "Toggle dark / light theme"],
                    ["b", "Add bookmark"],
                    ["B", "View bookmarks"],
                    ["t", "Chapter list (TOC)"],
                    ["/", "Search in book"],
                    ["q", "Back to library"],
                ],
            },
            {
                title: "📚 Library",
                keys: [
                    ["j / k / ↑ / ↓", "Navigate books"],
                    ["Enter", "Open selected book"],
                    ["/", "Search library"],
                    ["Esc", "Clear search"],
                    ["n", "Import new books"],
                    ["i", "Reading statistics"],
                    ["d", "Delete book"],
                    ["q", "Back to splash"],
                ],
            },
            {
                title: "📂 Import",
                keys: [
                    ["Enter", "Scan directory / import file"],
                    ["a", "Import all found files"],
                    ["j / k", "Navigate files"],
                    ["/", "Edit scan path"],
                    ["q", "Back to library"],
                ],
            },
            {
                title: "🌐 Global",
                keys: [
                    ["?", "Toggle this help"],
                    ["Ctrl+C", "Force quit"],
                ],
            },
        ]

        for (const section of sections) {
            this.container.add(new TextRenderable(this.renderer, {
                id: `help-section-${section.title}`,
                content: t`\n${bold(fg(theme.accent.purple)(section.title))}`,
            }))

            for (const [key, desc] of section.keys) {
                const paddedKey = key.padEnd(18)
                this.container.add(new TextRenderable(this.renderer, {
                    id: `help-key-${key.replace(/\s/g, "")}`,
                    content: t`  ${fg(theme.accent.amber)(paddedKey)} ${fg(theme.text.body)(desc)}`,
                }))
            }
        }

        // Footer hint
        this.container.add(new TextRenderable(this.renderer, {
            id: "help-footer",
            content: t`\n${fg(theme.text.subtle)("Press ? or q or Esc to close")}`,
        }))

        this.renderer.root.add(this.container)

        // Input handler
        this.renderer.addInputHandler((seq: string) => {
            if (!this.visible) return false
            if (seq === "?" || seq === "q" || seq === "\x1b") {
                this.hide()
                return true
            }
            return true // consume all input while help is open
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
