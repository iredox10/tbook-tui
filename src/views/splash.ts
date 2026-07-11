// ─────────────────────────────────────────────────────────────
// Splash Screen — cinematic literary landing experience
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ASCIIFontRenderable,
    SelectRenderable, SelectRenderableEvents,
    t, bold, italic, fg,
} from "@opentui/core"
import { theme, truncate } from "../utils/theme"
import { enableSelectTap } from "../utils/touch"
import { getAllBooks, getTotalStats, getTodayStats } from "../services/database"
import type { App } from "../app"
import { HelpOverlay } from "../components/help-overlay"

const READING_QUOTES = [
    "A reader lives a thousand lives before he dies.",
    "Books are a uniquely portable magic.",
    "Reading brings us unknown friends.",
    "A book is a dream that you hold in your hand.",
    "Reading is an exercise in empathy.",
]

interface MenuOption {
    name: string
    value: string
}

export class SplashView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private menu!: SelectRenderable
    private removeHandler?: () => void
    private helpOverlay?: HelpOverlay
    private modalOpen = false

    constructor(renderer: CliRenderer, app: App) {
        this.renderer = renderer
        this.app = app
    }

    render() {
        const books = getAllBooks()
        const lastBook = books.length > 0 ? books[0] : null
        const totalStats = getTotalStats()
        const todayStats = getTodayStats()
        const quote = READING_QUOTES[Math.floor(Math.random() * READING_QUOTES.length)]
        const termHeight = this.renderer.height || 24
        const showQuote = termHeight >= 24

        // ── Root container ──
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

        // ── Atmospheric background bars ──
        const termWidth = this.renderer.width || 80
        const termH = this.renderer.height || 24
        const bgBars = [
            { x: Math.floor(termWidth * 0.08), w: Math.floor(termWidth * 0.12), color: theme.accent.cyan, opacity: 0.04 },
            { x: Math.floor(termWidth * 0.35), w: Math.floor(termWidth * 0.18), color: theme.accent.purple, opacity: 0.05 },
            { x: Math.floor(termWidth * 0.62), w: Math.floor(termWidth * 0.14), color: theme.accent.pink, opacity: 0.04 },
            { x: Math.floor(termWidth * 0.82), w: Math.floor(termWidth * 0.10), color: theme.accent.blue, opacity: 0.03 },
        ]
        for (let i = 0; i < bgBars.length; i++) {
            const bar = bgBars[i]!
            this.container.add(new BoxRenderable(this.renderer, {
                id: `splash-bg-bar-${i}`,
                position: "absolute",
                top: 0,
                left: bar.x,
                width: bar.w,
                height: termH,
                backgroundColor: bar.color,
                opacity: bar.opacity,
            }))
        }

        // ── Main card ──
        const cardBox = new BoxRenderable(this.renderer, {
            id: "splash-card",
            width: Math.min(this.renderer.width - 6, 88),
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "flex-start",
            backgroundColor: theme.bg.surface,
            border: true,
            borderStyle: "rounded",
            borderColor: theme.border.focused,
            paddingY: 1,
            paddingX: 2,
            gap: 0,
        })

        // ── Header ──
        const headerBox = new BoxRenderable(this.renderer, {
            id: "splash-header-box",
            width: "100%",
            flexDirection: "column",
            alignItems: "center",
            gap: 0,
        })

        const logo = new ASCIIFontRenderable(this.renderer, {
            id: "splash-logo",
            text: "TBOOK",
            font: "slick",
            color: [theme.accent.cyan, theme.accent.blue, theme.accent.purple, theme.accent.pink],
        })

        const tagline = new TextRenderable(this.renderer, {
            id: "splash-tagline",
            content: t`${fg(theme.text.bright)("Terminal Book Reader")} ${fg(theme.text.muted)("— Reimagined")}`,
        })

        const versionBadge = new TextRenderable(this.renderer, {
            id: "splash-version",
            content: t`${fg(theme.text.muted)("v1.0.3")}`,
        })

        headerBox.add(logo)
        headerBox.add(tagline)
        headerBox.add(versionBadge)

        // ── Decorative divider ──
        const divider = new BoxRenderable(this.renderer, {
            id: "splash-divider",
            width: "100%",
            height: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
        })
        const dividerText = new TextRenderable(this.renderer, {
            id: "splash-divider-text",
            content: t`${fg(theme.border.normal)("✦ ━━━━━━━━━━━━━━━ ✦")}`,
        })
        divider.add(dividerText)

        // ── Stats dashboard ──
        const statsRow = new BoxRenderable(this.renderer, {
            id: "splash-stats-row",
            width: "100%",
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 1,
            flexWrap: "wrap",
        })

        const todayWords = todayStats.words_read
        const statChips: { label: string; value: string; icon: string; color: string }[] = [
            { label: "Library", value: String(books.length), icon: "◆", color: theme.accent.blue },
            { label: "Started", value: String(totalStats.books_read), icon: "▶", color: theme.accent.purple },
            { label: "Today", value: todayWords >= 1000 ? `${(todayWords / 1000).toFixed(1)}k` : String(todayWords), icon: "✦", color: theme.accent.cyan },
            { label: "Streak", value: `${totalStats.streak}d`, icon: "●", color: totalStats.streak > 0 ? theme.accent.pink : theme.text.muted },
        ]

        for (const stat of statChips) {
            statsRow.add(this.createStatCard(stat.label, stat.value, stat.icon, stat.color))
        }

        // ── Action menu ──
        const menuOptions: MenuOption[] = []

        if (lastBook) {
            menuOptions.push({
                name: `Continue: ${truncate(lastBook.title, 24)}`,
                value: "continue",
            })
        }

        menuOptions.push(
            { name: "✦ Open Library", value: "library" },
            { name: "⟳ Import Books", value: "import" },
            { name: "◈ Reading Stats", value: "stats" },
        )

        this.menu = new SelectRenderable(this.renderer, {
            id: "splash-menu",
            width: "100%",
            height: menuOptions.length + 2,
            options: menuOptions.map(o => ({ name: o.name, description: "", value: o.value })),
            backgroundColor: "transparent",
            selectedBackgroundColor: theme.bg.hover,
            selectedTextColor: theme.accent.cyan,
            textColor: theme.text.body,
            descriptionColor: theme.text.subtle,
            selectedDescriptionColor: theme.accent.blue,
            showDescription: false,
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
                case "stats":
                    this.app.showStats()
                    break
            }
        })

        this.menu.focus()

        // ── Quote ──
        let quoteText: TextRenderable | null = null
        if (showQuote) {
            quoteText = new TextRenderable(this.renderer, {
                id: "splash-quote",
                content: t`${fg(theme.border.normal)("— ")}${italic(fg(theme.text.muted)(`“${quote}”`))}`,
            })
        }

        // ── Assemble card ──
        cardBox.add(headerBox)
        cardBox.add(divider)
        cardBox.add(statsRow)
        cardBox.add(this.menu)
        if (quoteText) cardBox.add(quoteText)

        // ── Footer hint ──
        const hint = new TextRenderable(this.renderer, {
            id: "splash-hint",
            content: t`${fg(theme.text.subtle)("Press ")}${fg(theme.accent.pink)("q")}${fg(theme.text.subtle)(" to quit · ")}${fg(theme.accent.pink)("?")}${fg(theme.text.subtle)(" for help · ")}${fg(theme.accent.pink)("j/k")}${fg(theme.text.subtle)(" to navigate")}`,
        })

        this.container.add(cardBox)
        this.container.add(hint)
        this.renderer.root.add(this.container)

        // Touch: tap a menu item to select + activate it.
        enableSelectTap(this.menu)

        // Handle quit / help
        const handler = (sequence: string) => {
            if (this.modalOpen) return false

            if (sequence === "q") {
                this.app.quit()
                return true
            }
            if (sequence === "?") {
                this.showHelp()
                return true
            }
            return false
        }
        this.renderer.addInputHandler(handler)
        this.removeHandler = () => {
            this.renderer.removeInputHandler(handler)
        }
    }

    private createStatCard(label: string, value: string, icon: string, color: string): BoxRenderable {
        const card = new BoxRenderable(this.renderer, {
            id: `splash-stat-${label.toLowerCase()}`,
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 10,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 0,
            paddingY: 0,
            paddingX: 1,
            backgroundColor: theme.bg.card,
            border: false,
        })

        // Top accent line
        const accent = new BoxRenderable(this.renderer, {
            id: `splash-stat-${label.toLowerCase()}-accent`,
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: 1,
            backgroundColor: color,
        })

        const valueRow = new TextRenderable(this.renderer, {
            id: `splash-stat-${label.toLowerCase()}-value`,
            content: t`${fg(color)(icon)} ${bold(fg(theme.text.bright)(value))}`,
        })

        const labelRow = new TextRenderable(this.renderer, {
            id: `splash-stat-${label.toLowerCase()}-label`,
            content: t`${fg(theme.text.muted)(label)}`,
        })

        card.add(accent)
        card.add(valueRow)
        card.add(labelRow)
        return card
    }

    private showHelp() {
        if (this.modalOpen) return
        this.modalOpen = true
        this.helpOverlay = new HelpOverlay(this.renderer, () => {
            this.modalOpen = false
            this.menu.focus()
        })
        this.helpOverlay.show()
    }

    destroy() {
        if (this.removeHandler) this.removeHandler()
        this.helpOverlay?.destroy()
        try {
            this.renderer.root.remove(this.container.id)
        } catch { }
    }
}
