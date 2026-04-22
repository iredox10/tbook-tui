// ─────────────────────────────────────────────────────────────
// Splash Screen — premium first impression with ASCII logo
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ASCIIFontRenderable,
    SelectRenderable, SelectRenderableEvents,
    t, bold, fg,
} from "@opentui/core"
import { theme } from "../utils/theme"
import { getAllBooks } from "../services/database"
import type { App } from "../app"

export class SplashView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private menu!: SelectRenderable
    private removeHandler?: () => void

    constructor(renderer: CliRenderer, app: App) {
        this.renderer = renderer
        this.app = app
    }

    render() {
        const books = getAllBooks()
        const lastBook = books.length > 0 ? books[0] : null

        // Full-screen centered container
        this.container = new BoxRenderable(this.renderer, {
            id: "splash-root",
            width: "100%",
            height: "100%",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.bg.void,
            gap: 1,
        })

        // ASCII Logo
        const logo = new ASCIIFontRenderable(this.renderer, {
            id: "splash-logo",
            text: "TBOOK",
            font: "block",
            color: [theme.accent.cyan, theme.accent.blue, theme.accent.purple],
        })

        // Tagline
        const tagline = new TextRenderable(this.renderer, {
            id: "splash-tagline",
            content: "Terminal Book Reader",
            fg: theme.text.muted,
        })

        // Spacer
        const spacer = new BoxRenderable(this.renderer, {
            id: "splash-spacer",
            height: 2,
            width: 1,
        })

        // Menu options
        const options: { name: string; description: string; value: string }[] = []

        if (lastBook) {
            const progress = lastBook.total_chapters > 0
                ? Math.round((lastBook.current_chapter / lastBook.total_chapters) * 100)
                : 0
            options.push({
                name: `→ Continue: ${lastBook.title}`,
                description: `Ch.${lastBook.current_chapter + 1}, ${progress}%`,
                value: "continue",
            })
        }

        options.push(
            { name: "→ Open Library", description: `${books.length} book${books.length !== 1 ? "s" : ""}`, value: "library" },
            { name: "→ Import Books", description: "Scan filesystem for EPUB files", value: "import" },
        )

        this.menu = new SelectRenderable(this.renderer, {
            id: "splash-menu",
            width: 50,
            height: options.length * 2 + 2,
            options,
            backgroundColor: "transparent",
            selectedBackgroundColor: theme.bg.hover,
            selectedTextColor: theme.accent.blue,
            textColor: theme.text.body,
            descriptionColor: theme.text.subtle,
            selectedDescriptionColor: theme.text.muted,
            showDescription: true,
        })

        this.menu.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: any) => {
            switch (option.value) {
                case "continue":
                    if (lastBook) this.app.openReader(lastBook.id)
                    break
                case "library":
                    this.app.showLibrary()
                    break
                case "import":
                    this.app.showImport()
                    break
            }
        })

        this.menu.focus()

        // Hint at bottom
        const hint = new TextRenderable(this.renderer, {
            id: "splash-hint",
            content: t`${fg(theme.text.subtle)("Press q to quit · ? for help")}`,
        })

        this.container.add(logo)
        this.container.add(tagline)
        this.container.add(spacer)
        this.container.add(this.menu)
        this.container.add(hint)
        this.renderer.root.add(this.container)

        // Handle quit
        const handler = (sequence: string) => {
            if (sequence === "q") {
                this.app.quit()
                return true
            }
            return false
        }
        this.renderer.addInputHandler(handler)
        this.removeHandler = () => {
            // OpenTUI doesn't expose removeInputHandler yet, but we track it
        }
    }

    destroy() {
        try {
            this.renderer.root.remove(this.container.id)
        } catch { }
    }
}
