// ─────────────────────────────────────────────────────────────
// Stats View — reading statistics dashboard
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    StyledText, type TextChunk,
    t, bold, fg,
} from "@opentui/core"
import { theme, progressBar, progressColor } from "../utils/theme"
import { enableTouchScroll } from "../utils/touch"
import { getWeeklyStats, getWeeklyStatsOffset, getTotalStats, getTodayStats, getSessionHistory } from "../services/database"
import { loadConfig } from "../services/config"
import { exportAllAnnotations } from "../services/export"
import { StatusBar } from "../components/status-bar"
import { showToast } from "../components/toast"
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
        const todayStats = getTodayStats()
        const config = loadConfig()
        const sessions = getSessionHistory(10)

        this.container = new BoxRenderable(this.renderer, {
            id: "stats-root",
            width: "100%",
            height: "100%",
            flexDirection: "column",
            backgroundColor: theme.bg.void,
            padding: 2,
            gap: 1,
        })

        // ── Scrollable content area ──
        const scrollArea = new ScrollBoxRenderable(this.renderer, {
            id: "stats-scroll",
            width: "100%",
            flexGrow: 1,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: theme.scrollbar.thumb,
                    backgroundColor: theme.scrollbar.track,
                },
            },
            contentOptions: {
                flexDirection: "column",
                gap: 1,
                padding: 0,
                backgroundColor: theme.bg.void,
            },
        })

        // ── Header ──
        const header = new TextRenderable(this.renderer, {
            id: "stats-header",
            content: t`${bold(fg(theme.accent.blue)("📊 Reading Statistics"))}`,
        })
        scrollArea.add(header)

        // ── Reading Goals ──
        const goal = config.readingGoal
        if (goal.dailyWords > 0 || goal.dailyMinutes > 0) {
            const goalBox = new BoxRenderable(this.renderer, {
                id: "stats-goals",
                width: "100%",
                borderStyle: "rounded",
                borderColor: theme.accent.green,
                backgroundColor: theme.bg.card,
                padding: 1,
                flexDirection: "column",
                gap: 0,
            })

            goalBox.add(new TextRenderable(this.renderer, {
                id: "stats-goals-title",
                content: t`${bold(fg(theme.accent.green)("🎯 Daily Reading Goals"))}`,
            }))

            if (goal.dailyWords > 0) {
                const wordPct = Math.min(100, Math.round((todayStats.words_read / goal.dailyWords) * 100))
                const bar = progressBar(wordPct, 25)
                const color = progressColor(wordPct)
                goalBox.add(new TextRenderable(this.renderer, {
                    id: "stats-goal-words",
                    content: t`  ${fg(theme.text.muted)("Words:")} ${fg(color)(bar)} ${fg(theme.text.body)(`${todayStats.words_read.toLocaleString()} / ${goal.dailyWords.toLocaleString()}`)} ${wordPct >= 100 ? fg(theme.accent.green)("✓ Done!") : ""}`,
                }))
            }

            if (goal.dailyMinutes > 0) {
                const minPct = Math.min(100, Math.round((todayStats.minutes_read / goal.dailyMinutes) * 100))
                const bar = progressBar(minPct, 25)
                const color = progressColor(minPct)
                goalBox.add(new TextRenderable(this.renderer, {
                    id: "stats-goal-mins",
                    content: t`  ${fg(theme.text.muted)("Time: ")} ${fg(color)(bar)} ${fg(theme.text.body)(`${todayStats.minutes_read}m / ${goal.dailyMinutes}m`)} ${minPct >= 100 ? fg(theme.accent.green)("✓ Done!") : ""}`,
                }))
            }

            scrollArea.add(goalBox)
        } else {
            scrollArea.add(new TextRenderable(this.renderer, {
                id: "stats-goals-hint",
                content: t`  ${fg(theme.text.subtle)("💡 Set reading goals in ~/.tbook/config.json (readingGoal.dailyWords / dailyMinutes)")}`,
            }))
        }

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
        const thisWeekWords = weekly.reduce((s: number, d: any) => s + d.words_read, 0)
        const lastWeekWords = lastWeek.reduce((s: number, d: any) => s + d.words_read, 0)
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

        // Helper to create a plain text chunk
        const plain = (text: string): TextChunk => ({ __isChunk: true, text } as TextChunk)

        // Render chart rows from top to bottom
        for (let row = chartHeight - 1; row >= 0; row--) {
            const chunks: TextChunk[] = [plain("  ")]
            for (const b of bars) {
                const blockIdx = Math.max(0, Math.min(vBlocks.length - 1, b.height - 1 - (chartHeight - 1 - row)))
                const showBlock = b.height > (chartHeight - 1 - row)
                if (showBlock) {
                    const color = b.isToday ? theme.accent.purple : theme.accent.blue
                    chunks.push(fg(color)(vBlocks[blockIdx]!))
                    chunks.push(plain(" "))
                } else {
                    chunks.push(plain("  "))
                }
            }
            chartBox.add(new TextRenderable(this.renderer, {
                id: `stats-vrow-${row}`,
                content: new StyledText(chunks),
            }))
        }

        // Day labels below the chart bars
        const labelChunks: TextChunk[] = [plain("  ")]
        for (const b of bars) {
            const color = b.isToday ? theme.accent.purple : theme.text.subtle
            labelChunks.push(fg(color)(b.label.padEnd(2)))
            labelChunks.push(plain(" "))
        }
        chartBox.add(new TextRenderable(this.renderer, {
            id: "stats-chart-labels",
            content: new StyledText(labelChunks),
        }))

        scrollArea.add(chartBox)

        // ── Summary Cards ──
        const cardsRow = new BoxRenderable(this.renderer, {
            id: "stats-cards",
            width: "100%",
            flexDirection: "row",
            gap: 2,
        })

        const totalMinutes = weekly.reduce((s: number, d: any) => s + d.minutes_read, 0)
        const formatDuration = (mins: number) => {
            const h = Math.floor(mins / 60)
            const m = Math.floor(mins % 60)
            return h > 0 ? `${h}h ${m}m` : `${m}m`
        }
        
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

        scrollArea.add(cardsRow)

        // ── Session History ──
        if (sessions.length > 0) {
            const historyBox = new BoxRenderable(this.renderer, {
                id: "stats-history",
                width: "100%",
                borderStyle: "rounded",
                borderColor: theme.border.normal,
                backgroundColor: theme.bg.card,
                padding: 1,
                flexDirection: "column",
                gap: 0,
            })

            historyBox.add(new TextRenderable(this.renderer, {
                id: "stats-history-title",
                content: t`${bold(fg(theme.accent.cyan)("📅 Recent Sessions"))}`,
            }))

            historyBox.add(new TextRenderable(this.renderer, {
                id: "stats-history-spacer",
                content: "",
            }))

            for (let i = 0; i < sessions.length; i++) {
                const s = sessions[i]!
                const date = s.ended_at ? new Date(s.ended_at).toLocaleDateString() : "Unknown"
                const time = s.ended_at ? new Date(s.ended_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""
                const chapters = s.start_chapter === s.end_chapter
                    ? `Ch.${s.start_chapter + 1}`
                    : `Ch.${s.start_chapter + 1}–${s.end_chapter + 1}`
                const title = s.book_title.length > 25 ? s.book_title.slice(0, 25) + "…" : s.book_title

                historyBox.add(new TextRenderable(this.renderer, {
                    id: `stats-session-${i}`,
                    content: t`  ${fg(theme.text.subtle)(date)} ${fg(theme.text.subtle)(time)} ${fg(theme.accent.blue)(title)} ${fg(theme.text.muted)(chapters)} ${fg(theme.text.subtle)(`${s.minutes_read}m · ${s.words_read.toLocaleString()} words`)}`,
                }))
            }

            scrollArea.add(historyBox)
        }

        this.container.add(scrollArea)

        // Touch: drag-to-scroll the stats dashboard.
        enableTouchScroll(scrollArea, { renderer: this.renderer })

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
            if (sequence === "j" || sequence === "\x1b[B") {
                scrollArea.scrollBy(1)
                return true
            }
            if (sequence === "k" || sequence === "\x1b[A") {
                scrollArea.scrollBy(-1)
                return true
            }
            if (sequence === "a" || sequence === "A") {
                // Export all annotations
                const result = exportAllAnnotations()
                if (result.success) {
                    showToast(this.renderer, `📝 Exported ${result.count} annotations to ${result.path}`, "success")
                } else {
                    showToast(this.renderer, `Failed: ${result.error}`, "error")
                }
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
