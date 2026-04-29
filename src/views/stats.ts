// ─────────────────────────────────────────────────────────────
// Stats View — reading statistics dashboard
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable,
    t, bold, fg,
} from "@opentui/core"
import { theme, progressBar, formatDuration } from "../utils/theme"
import { getWeeklyStats, getTotalStats } from "../services/database"
import { getWeeklyStatsOffset } from "../services/database"
import { StatusBar } from "../components/status-bar"
import type { App } from "../app"

export class StatsView {
    private renderer: CliRenderer
    private app: App
    private container!: BoxRenderable
    private statusBar!: StatusBar
    private inputHandler?: (sequence: string) => boolean

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

        // ── Weekly Bar Chart (Compact vertical blocks) ──
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

        const chartTitleRow = new BoxRenderable(this.renderer, {
            id: "stats-chart-title-row",
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
            alignItems: "center",
        })

        chartTitleRow.add(new TextRenderable(this.renderer, {
            id: "stats-chart-title",
            content: t`${bold(fg(theme.text.bright)("Daily Words Read (This Week)"))}`,
        }))

        // Trend comparison: this week vs last week
        const lastWeek = getWeeklyStatsOffset(7)
        const thisWeekWords = weekly.reduce((s, d) => s + d.words_read, 0)
        const lastWeekWords = lastWeek.reduce((s, d) => s + d.words_read, 0)
        const trend = thisWeekWords >= lastWeekWords
            ? fg(theme.accent.green)(`▲ ${((thisWeekWords - lastWeekWords) / Math.max(1, lastWeekWords) * 100).toFixed(0)}%`)
            : fg(theme.accent.pink)(`▼ ${((lastWeekWords - thisWeekWords) / Math.max(1, lastWeekWords) * 100).toFixed(0)}%`)

        chartTitleRow.add(new TextRenderable(this.renderer, {
            id: "stats-trend",
            content: t`${fg(theme.text.muted)("vs last week: ")}${trend}`,
        }))

        chartBox.add(chartTitleRow)

        chartBox.add(new TextRenderable(this.renderer, {
            id: "stats-chart-spacer",
            content: "",
        }))

        // Build compact vertical bar chart
        const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        const today = new Date()
        const bars: { label: string; height: number; words: number; isToday: boolean; dayIndex: number }[] = []
        let maxWords = 1

        for (let i = 6; i >= 0; i--) {
            const d = new Date(today)
            d.setDate(d.getDate() - i)
            const dateStr = d.toISOString().slice(0, 10)
            const dayIndex = (d.getDay() + 6) % 7
            const stat = weekly.find(s => s.date === dateStr)
            const words = stat?.words_read || 0
            if (words > maxWords) maxWords = words
            bars.push({
                label: dayNames[dayIndex]!,
                height: Math.round((words / maxWords) * 8),
                words,
                isToday: i === 0,
                dayIndex,
            })
        }

        // Re-scale heights now that we know true max
        for (const b of bars) {
            b.height = Math.round((b.words / maxWords) * 8)
        }

        const vBlocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
        const chartHeight = 8

        // Render chart rows from top to bottom
        for (let row = chartHeight - 1; row >= 0; row--) {
            let line = "  "
            for (const b of bars) {
                const blockIdx = Math.max(0, Math.min(vBlocks.length - 1, b.height - 1 - (chartHeight - 1 - row)))
                const showBlock = b.height > (chartHeight - 1 - row)
                if (showBlock) {
                    const color = b.isToday ? theme.accent.purple : theme.accent.blue
                    line += `${fg(color)(vBlocks[blockIdx]!)} `
                } else {
                    line += "  "
                }
            }
            chartBox.add(new TextRenderable(this.renderer, {
                id: `stats-vrow-${row}`,
                content: line,
            }))
        }

        // Day labels row
        let labelLine = "  "
        for (const b of bars) {
            const color = b.isToday ? theme.text.bright : theme.text.muted
            labelLine += `${fg(color)(b.label.slice(0, 2))} `
        }
        chartBox.add(new TextRenderable(this.renderer, {
            id: "stats-vlabels",
            content: labelLine,
        }))

        // Word count row
        let countLine = "  "
        for (const b of bars) {
            const s = b.words > 0 ? (b.words >= 1000 ? (b.words / 1000).toFixed(1) + "k" : b.words.toString()) : "-"
            const color = b.isToday ? theme.text.bright : theme.text.muted
            countLine += `${fg(color)(s.padStart(2).slice(0, 2))} `
        }
        chartBox.add(new TextRenderable(this.renderer, {
            id: "stats-vcounts",
            content: countLine,
        }))

        this.container.add(chartBox)

        // ── Summary Cards ──
        const cardsRow = new BoxRenderable(this.renderer, {
            id: "stats-cards",
            width: "100%",
            flexDirection: "row",
            gap: 2,
        })

        const totalMinutes = weekly.reduce((s, d) => s + d.minutes_read, 0)
        const cardData = [
            { icon: "📖", label: "Books Read", value: totals.books_read.toString(), color: theme.accent.blue },
            { icon: "📝", label: "Total Words", value: totals.total_words.toLocaleString(), color: theme.accent.purple },
            { icon: "⏱", label: "Time Spent", value: formatDuration(totalMinutes), color: theme.accent.cyan },
            { icon: "🔥", label: "Streak", value: `${totals.streak} day${totals.streak !== 1 ? "s" : ""}`, color: theme.accent.orange },
        ]

        for (let i = 0; i < cardData.length; i++) {
            const cd = cardData[i]!
            const card = new BoxRenderable(this.renderer, {
                id: `stats-card-${i}`,
                width: 18,
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
        this.inputHandler = (sequence: string) => {
            if (sequence === "q") {
                this.app.showLibrary()
                return true
            }
            return false
        }
        this.renderer.addInputHandler(this.inputHandler)
    }

    destroy() {
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
        }
        this.statusBar.destroy()
        try { this.renderer.root.remove(this.container.id) } catch { }
    }
}
