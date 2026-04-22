// ─────────────────────────────────────────────────────────────
// Stats View — reading statistics dashboard
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable,
    t, bold, fg,
} from "@opentui/core"
import { theme, progressBar } from "../utils/theme"
import { getWeeklyStats, getTotalStats } from "../services/database"
import { StatusBar } from "../components/status-bar"
import type { App } from "../app"

export class StatsView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private statusBar!: StatusBar

    constructor(renderer: CliRenderer, app: App) {
        this.renderer = renderer
        this.app = app
    }

    render() {
        const weekly = getWeeklyStats()
        const totals = getTotalStats()

        this.container = new BoxRenderable(this.renderer, {
            id: "stats-root",
            width: "100%",
            height: "100%",
            flexDirection: "column",
            backgroundColor: theme.bg.void,
            padding: 2,
            gap: 2,
        })

        // ── Header ──
        const header = new TextRenderable(this.renderer, {
            id: "stats-header",
            content: t`${bold(fg(theme.accent.blue)("📊 Reading Statistics"))}`,
        })
        this.container.add(header)

        // ── Weekly Bar Chart ──
        const chartBox = new BoxRenderable(this.renderer, {
            id: "stats-chart",
            width: "100%",
            borderStyle: "rounded",
            borderColor: theme.border.normal,
            backgroundColor: theme.bg.card,
            padding: 2,
            flexDirection: "column",
            gap: 0,
        })

        const chartTitle = new TextRenderable(this.renderer, {
            id: "stats-chart-title",
            content: t`${bold(fg(theme.text.bright)("Daily Words Read (This Week)"))}`,
        })
        chartBox.add(chartTitle)

        chartBox.add(new TextRenderable(this.renderer, {
            id: "stats-chart-spacer",
            content: "",
        }))

        // Find max for scaling
        const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        const maxWords = Math.max(1, ...weekly.map(s => s.words_read))

        // Fill in all 7 days
        const today = new Date()
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today)
            d.setDate(d.getDate() - i)
            const dateStr = d.toISOString().slice(0, 10)
            const dayIndex = (d.getDay() + 6) % 7 // Monday = 0
            const stat = weekly.find(s => s.date === dateStr)
            const words = stat?.words_read || 0
            const barWidth = Math.round((words / maxWords) * 30)
            const bar = "█".repeat(barWidth) + "░".repeat(30 - barWidth)

            const isToday = i === 0
            const dayLabel = dayNames[dayIndex]

            const color = isToday ? theme.accent.purple : theme.accent.blue
            const wordStr = words.toLocaleString().padStart(8)

            chartBox.add(new TextRenderable(this.renderer, {
                id: `stats-bar-${i}`,
                content: t`  ${fg(isToday ? theme.text.bright : theme.text.muted)(dayLabel!.padEnd(4))} ${fg(color)(bar)} ${fg(theme.text.muted)(wordStr)}${isToday && words === maxWords ? fg(theme.accent.amber)(" ← best!") : ""}`,
            }))
        }

        this.container.add(chartBox)

        // ── Summary Cards ──
        const cardsRow = new BoxRenderable(this.renderer, {
            id: "stats-cards",
            width: "100%",
            flexDirection: "row",
            gap: 2,
        })

        const cardData = [
            { icon: "📖", label: "Books Read", value: totals.books_read.toString(), color: theme.accent.blue },
            { icon: "📝", label: "Total Words", value: totals.total_words.toLocaleString(), color: theme.accent.purple },
            { icon: "🔥", label: "Streak", value: `${totals.streak} day${totals.streak !== 1 ? "s" : ""}`, color: theme.accent.orange },
        ]

        for (let i = 0; i < cardData.length; i++) {
            const cd = cardData[i]!
            const card = new BoxRenderable(this.renderer, {
                id: `stats-card-${i}`,
                width: 20,
                height: 5,
                borderStyle: "rounded",
                borderColor: cd.color,
                backgroundColor: theme.bg.card,
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 0,
            })

            card.add(new TextRenderable(this.renderer, {
                id: `stats-card-icon-${i}`,
                content: t`${cd.icon} ${fg(theme.text.muted)(cd.label)}`,
            }))

            card.add(new TextRenderable(this.renderer, {
                id: `stats-card-value-${i}`,
                content: t`${bold(fg(cd.color)(cd.value))}`,
            }))

            cardsRow.add(card)
        }

        this.container.add(cardsRow)

        // ── Status bar ──
        this.statusBar = new StatusBar({ renderer: this.renderer, mode: "stats" })

        this.renderer.root.add(this.container)
        this.renderer.root.add(this.statusBar.root)

        // ── Keybinds ──
        this.renderer.addInputHandler((sequence: string) => {
            if (sequence === "q") {
                this.app.showLibrary()
                return true
            }
            return false
        })
    }

    destroy() {
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
