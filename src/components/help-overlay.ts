// ─────────────────────────────────────────────────────────────
// Help Overlay — modal keybind reference (scrollable)
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    t, bold, fg,
} from "@opentui/core"
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
            top: 1,
            bottom: 1,
            left: "10%",
            right: "10%",
            borderStyle: "rounded",
            borderColor: theme.accent.cyan,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 0,
        })

        // Title (fixed header)
        this.container.add(new TextRenderable(this.renderer, {
            id: "help-title",
            content: t` ${bold(fg(theme.accent.cyan)("⌨  Keyboard Shortcuts"))}`,
        }))

        this.container.add(new TextRenderable(this.renderer, {
            id: "help-sep",
            content: " " + "━".repeat(44),
            fg: theme.border.normal,
        }))

        // Scrollable content area
        const scrollArea = new ScrollBoxRenderable(this.renderer, {
            id: "help-scroll",
            width: "100%",
            flexGrow: 1,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: theme.scrollbar.thumb,
                    backgroundColor: theme.scrollbar.track,
                },
            },
            contentOptions: {
                paddingLeft: 1,
                paddingRight: 1,
                flexDirection: "column",
                gap: 0,
                backgroundColor: theme.bg.card,
            },
        })

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
                    ["f", "Toggle focus mode"],
                    ["Tab", "Toggle chapter sidebar"],
                    ["T", "Toggle dark / light theme"],
                    ["b", "Add bookmark"],
                    ["B", "View bookmarks"],
                    ["N", "View annotations & highlights"],
                    ["V", "Vocabulary list"],
                    ["t", "Chapter list (TOC)"],
                    ["/", "Search in book"],
                    ["s", "Select mode (pick word)"],
                    ["r", "RSVP speed reader"],
                    ["D", "Dictionary (select text + D)"],
                    ["E", "Export to Obsidian/Logseq"],
                    ["q", "Back to library"],
                ],
            },
            {
                title: "✎ Select Mode",
                keys: [
                    ["h / l", "Move cursor left / right (word)"],
                    ["j / k", "Move cursor up / down (paragraph)"],
                    ["v", "Toggle visual mode (range)"],
                    ["m", "Mark / highlight selection"],
                    ["d", "Dictionary lookup on selection"],
                    ["Enter", "Confirm selection"],
                    ["Esc", "Exit select mode"],
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
                    ["Enter", "Scan directory / import"],
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
            scrollArea.add(new TextRenderable(this.renderer, {
                id: `help-s-${section.title.slice(2, 6)}`,
                content: t`\n${bold(fg(theme.accent.purple)(section.title))}`,
            }))

            for (let ki = 0; ki < section.keys.length; ki++) {
                const [key, desc] = section.keys[ki]!
                const paddedKey = key!.padEnd(18)
                scrollArea.add(new TextRenderable(this.renderer, {
                    id: `help-k-${section.title.slice(2, 5)}-${ki}`,
                    content: t`  ${fg(theme.accent.amber)(paddedKey)} ${fg(theme.text.body)(desc!)}`,
                }))
            }
        }

        this.container.add(scrollArea)

        // Footer (fixed)
        this.container.add(new TextRenderable(this.renderer, {
            id: "help-footer",
            content: t`${fg(theme.text.subtle)(" j/k Scroll · ? or q or Esc to close")}`,
        }))

        this.renderer.root.add(this.container)
        scrollArea.focus()

        // Input handler
        this.renderer.addInputHandler((seq: string) => {
            if (!this.visible) return false
            if (seq === "?" || seq === "q" || seq === "\x1b") {
                this.hide()
                return true
            }
            // Allow j/k scrolling within the help
            if (seq === "j" || seq === "\x1b[B") {
                scrollArea.scrollBy(1)
                return true
            }
            if (seq === "k" || seq === "\x1b[A") {
                scrollArea.scrollBy(-1)
                return true
            }
            if (seq === " ") {
                scrollArea.scrollBy(1, "viewport")
                return true
            }
            return true // consume all other input while help is open
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
