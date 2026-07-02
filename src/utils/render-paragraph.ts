// ─────────────────────────────────────────────────────────────
// Paragraph Renderer — extracted from reader.ts for cleanliness
// Renders each StyledParagraph type into OpenTUI TextRenderables
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import { TextRenderable, StyledText, type TextChunk, t, bold, italic, fg, bg } from "@opentui/core"
import type { ThemeColors } from "./theme"
import { formatInlineRichText } from "./theme"
import { formatTable } from "./html-to-text"
import type { StyledParagraph } from "./html-to-text"

export interface RenderedNode {
    node: TextRenderable
    paragraphIndex: number
}

/**
 * Render a single StyledParagraph into a TextRenderable.
 */
export function renderParagraph(
    renderer: CliRenderer,
    para: StyledParagraph,
    index: number,
    th: ThemeColors,
): TextRenderable {
    const textProps = {
        wrapMode: "word" as const,
        selectable: true,
        selectionBg: th.accent.blue,
        selectionFg: th.bg.void,
    }

    switch (para.type) {
        case "heading": {
            const color = para.level === 1 ? th.accent.purple
                : para.level === 2 ? th.accent.blue
                    : para.level === 3 ? th.accent.cyan
                        : th.accent.green
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                ...textProps,
                content: t`\n\n${bold(fg(color)(para.text))}\n`,
            })
        }

        case "quote": {
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                ...textProps,
                content: t`\n  ${fg(th.accent.cyan)("│")} ${italic(fg(th.text.muted)(para.text))}\n`,
            })
        }

        case "separator": {
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                content: `\n${"  ◆  ◆  ◆".padStart(22)}\n`,
                fg: th.text.subtle,
            })
        }

        case "list-item": {
            const indent = "  ".repeat((para.indent || 0) + 1)
            let bullet: string
            if (para.ordered) {
                bullet = `${para.index}.`
            } else {
                const bullets = ["•", "◦", "▪", "▸"]
                bullet = bullets[Math.min(para.indent || 0, bullets.length - 1)]!
            }
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                ...textProps,
                content: t`${indent}${fg(th.accent.cyan)(bullet)} ${fg(th.text.body)(para.text)}`,
            })
        }

        case "code": {
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                ...textProps,
                content: formatCodeBlock(para.text, para.language),
                fg: th.text.body,
            })
        }

        case "table": {
            const tableText = para.tableRows ? formatTable(para.tableRows) : para.text
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                ...textProps,
                content: `\n${tableText}\n`,
                fg: th.text.body,
            })
        }

        case "note": {
            const icons: Record<string, string> = {
                tip: "💡", warning: "⚠️", note: "📝", important: "❗",
            }
            const colors: Record<string, string> = {
                tip: th.accent.green, warning: th.accent.amber,
                note: th.accent.cyan, important: th.accent.pink,
            }
            const kind = para.noteKind || "note"
            const icon = icons[kind] || "📝"
            const color = colors[kind] || th.accent.cyan
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                ...textProps,
                content: t`\n  ${fg(color)("┃")} ${icon} ${bold(fg(color)(kind.toUpperCase()))}\n  ${fg(color)("┃")} ${fg(th.text.body)(para.text)}\n`,
            })
        }

        default: {
            const raw = para.text || ""
            const rich = formatInlineRichText(raw)
            if (rich.chunks.length > 0) {
                const nl = (s: string): TextChunk => ({ __isChunk: true, text: s } as TextChunk)
                return new TextRenderable(renderer, {
                    id: `para-${index}`,
                    ...textProps,
                    content: new StyledText([nl("\n"), ...rich.chunks, nl("\n")]),
                })
            }
            return new TextRenderable(renderer, {
                id: `para-${index}`,
                ...textProps,
                content: "",
            })
        }
    }
}

/**
 * Format a code block with bordered box, line numbers, and language label.
 */
export function formatCodeBlock(code: string, language?: string): string {
    const lines = code.split("\n")
    const lineNumWidth = String(lines.length).length
    const numberedLines = lines.map((line, idx) => {
        const num = String(idx + 1).padStart(lineNumWidth)
        return `  ${num} │ ${line}`
    }).join("\n")

    const label = language && language !== "text" ? ` ${language} ` : ""
    const ruleWidth = Math.max(18, 34 - label.length)
    const topBar = label
        ? `\n  ╭${"─".repeat(2)}${label}${"─".repeat(ruleWidth)}`
        : `\n  ╭${"─".repeat(38)}`
    const botBar = `  ╰${"─".repeat(38)}`

    return `${topBar}\n${numberedLines}\n${botBar}\n`
}

/**
 * Restore a paragraph's original appearance (no selection highlights).
 */
export function restoreParagraph(
    renderer: CliRenderer,
    para: StyledParagraph,
    index: number,
    th: ThemeColors,
): TextRenderable {
    return renderParagraph(renderer, para, index, th)
}

/**
 * Apply a word-level highlight to a paragraph node.
 * Preserves the paragraph's structural styling while highlighting a word range.
 */
export function applyWordHighlight(
    node: TextRenderable,
    para: StyledParagraph,
    th: ThemeColors,
    prefix: string,
    highlighted: string,
    suffix: string,
) {
    switch (para.type) {
        case "heading": {
            const color = para.level === 1 ? th.accent.purple
                : para.level === 2 ? th.accent.blue
                    : para.level === 3 ? th.accent.cyan
                        : th.accent.green
            node.content = t`\n\n${fg(th.text.body)(prefix)}${bold(bg(th.accent.amber)(fg(th.bg.void)(highlighted)))}${fg(color)(suffix)}\n`
            break
        }
        case "quote":
            node.content = t`\n  ${fg(th.accent.cyan)("│")} ${fg(th.text.muted)(prefix)}${bold(bg(th.accent.amber)(fg(th.bg.void)(highlighted)))}${fg(th.text.muted)(suffix)}\n`
            break
        case "list-item": {
            const indent = "  ".repeat((para.indent || 0) + 1)
            const bullet = para.ordered ? `${para.index}.` : "•"
            node.content = t`${indent}${fg(th.accent.cyan)(bullet)} ${fg(th.text.body)(prefix)}${bold(bg(th.accent.amber)(fg(th.bg.void)(highlighted)))}${fg(th.text.body)(suffix)}`
            break
        }
        default:
            node.content = t`\n${fg(th.text.body)(prefix)}${bold(bg(th.accent.amber)(fg(th.bg.void)(highlighted)))}${fg(th.text.body)(suffix)}\n`
            break
    }
}

/**
 * Dim a paragraph node for visual mode (non-selected text).
 */
export function dimParagraph(node: TextRenderable, para: StyledParagraph, th: ThemeColors) {
    // Re-render with dimmed colors
    const dimmedText = para.text || ""
    node.content = `\n${fg(th.text.dim)(dimmedText)}\n`
    if (para.type === "heading") {
        node.content = t`\n\n${fg(th.text.dim)(dimmedText)}\n`
    } else if (para.type === "quote") {
        node.content = t`\n  ${fg(th.text.dim)("│ " + dimmedText)}\n`
    } else if (para.type === "list-item") {
        const indent = "  ".repeat((para.indent || 0) + 1)
        const bullet = para.ordered ? `${para.index}.` : "•"
        node.content = t`${indent}${fg(th.text.dim)(bullet + " " + dimmedText)}`
    }
}

