// ─────────────────────────────────────────────────────────────
// HTML → Styled paragraphs for terminal rendering
// Enhanced for programming books: code blocks, inline code,
// tables, definition lists, and more.
// ─────────────────────────────────────────────────────────────

import { parse as parseHTML } from "node-html-parser"

export interface StyledParagraph {
    type: "heading" | "paragraph" | "quote" | "separator" | "list-item" | "code" | "table" | "note"
    text: string
    level?: number  // heading level (1-6)
    indent?: number // nesting depth for lists
    ordered?: boolean // numbered list?
    index?: number  // list item index (for ordered lists)
    language?: string // programming language for code blocks
    tableRows?: string[][] // parsed table data for table type
    noteKind?: "tip" | "warning" | "note" | "important" // callout type
}

/**
 * Convert an HTML chapter string into an array of styled paragraphs.
 * Handles headings, paragraphs, lists, blockquotes, code blocks,
 * inline code, tables, definition lists, callouts, and more.
 */
export function htmlToStyledParagraphs(html: string): StyledParagraph[] {
    const root = parseHTML(html, {
        blockTextElements: {
            pre: true,
            script: false,
            style: false,
        },
    })

    const paragraphs: StyledParagraph[] = []

    function walkNode(node: any, depth: number = 0) {
        if (node.nodeType === 3) {
            // Text node — handled by parent
            return
        }

        const tag = (node.tagName || "").toLowerCase()

        // ── Headings ──
        if (/^h[1-6]$/.test(tag)) {
            const text = cleanText(node.textContent)
            if (text) {
                paragraphs.push({
                    type: "heading",
                    text,
                    level: parseInt(tag[1]!),
                })
            }
            return
        }

        // ── Blockquotes ──
        if (tag === "blockquote") {
            // Check if it's a callout/admonition
            const classAttr = (node.getAttribute?.("class") || "").toLowerCase()
            let noteKind: StyledParagraph["noteKind"]
            if (classAttr.includes("warning") || classAttr.includes("caution")) noteKind = "warning"
            else if (classAttr.includes("tip") || classAttr.includes("hint")) noteKind = "tip"
            else if (classAttr.includes("important")) noteKind = "important"
            else if (classAttr.includes("note") || classAttr.includes("info")) noteKind = "note"

            const text = cleanText(node.textContent)
            if (text) {
                if (noteKind) {
                    paragraphs.push({ type: "note", text, noteKind })
                } else {
                    paragraphs.push({ type: "quote", text })
                }
            }
            return
        }

        // ── HR / separators ──
        if (tag === "hr") {
            paragraphs.push({ type: "separator", text: "" })
            return
        }

        // ── Pre / code blocks ──
        if (tag === "pre") {
            // Try to detect language from nested <code> element's class attribute
            let language = "text"
            let codeText = ""
            const codeChild = node.childNodes?.find?.(
                (c: any) => (c.tagName || "").toLowerCase() === "code"
            )
            if (codeChild) {
                const classAttr = codeChild.getAttribute?.("class") || ""
                const { detectLanguage } = require("./syntax-highlight")
                language = detectLanguage(classAttr)
                codeText = codeChild.textContent?.trim() || ""
            } else {
                codeText = node.textContent?.trim() || ""
            }

            // If language wasn't detected from class, try heuristic detection
            if (language === "text" && codeText.length > 10) {
                const { detectLanguageFromContent } = require("./syntax-highlight")
                language = detectLanguageFromContent(codeText)
            }

            if (codeText) {
                paragraphs.push({ type: "code", text: codeText, language })
            }
            return
        }

        // ── Tables ──
        if (tag === "table") {
            const rows: string[][] = []
            const trs = node.querySelectorAll?.("tr") || []
            for (const tr of trs) {
                const cells: string[] = []
                const tds = [...(tr.querySelectorAll?.("th") || []), ...(tr.querySelectorAll?.("td") || [])]
                for (const td of tds) {
                    cells.push(cleanText(td.textContent))
                }
                if (cells.length > 0) rows.push(cells)
            }

            if (rows.length > 0) {
                // Create a text representation for search/select and store parsed data
                const textRepr = rows.map(r => r.join(" │ ")).join("\n")
                paragraphs.push({
                    type: "table",
                    text: textRepr,
                    tableRows: rows,
                })
            }
            return
        }

        // ── Definition lists ──
        if (tag === "dl") {
            for (const child of node.childNodes) {
                const childTag = (child.tagName || "").toLowerCase()
                if (childTag === "dt") {
                    const text = cleanText(child.textContent)
                    if (text) {
                        paragraphs.push({ type: "heading", text, level: 5 })
                    }
                } else if (childTag === "dd") {
                    const text = cleanText(child.textContent)
                    if (text) {
                        paragraphs.push({ type: "paragraph", text: `  ${text}`, indent: 1 })
                    }
                }
            }
            return
        }

        // ── Callout / admonition divs ──
        if (tag === "div" || tag === "aside") {
            const classAttr = (node.getAttribute?.("class") || "").toLowerCase()
            if (classAttr.includes("warning") || classAttr.includes("caution") ||
                classAttr.includes("tip") || classAttr.includes("hint") ||
                classAttr.includes("note") || classAttr.includes("info") ||
                classAttr.includes("important") || classAttr.includes("admonition")) {

                let noteKind: StyledParagraph["noteKind"] = "note"
                if (classAttr.includes("warning") || classAttr.includes("caution")) noteKind = "warning"
                else if (classAttr.includes("tip") || classAttr.includes("hint")) noteKind = "tip"
                else if (classAttr.includes("important")) noteKind = "important"

                const text = cleanText(node.textContent)
                if (text) {
                    paragraphs.push({ type: "note", text, noteKind })
                    return
                }
            }
        }

        // ── Ordered lists ──
        if (tag === "ol") {
            let itemIndex = 0
            for (const child of node.childNodes) {
                const childTag = (child.tagName || "").toLowerCase()
                if (childTag === "li") {
                    itemIndex++
                    const text = cleanTextWithInlineCode(child)
                    if (text) {
                        paragraphs.push({
                            type: "list-item",
                            text,
                            indent: depth,
                            ordered: true,
                            index: itemIndex,
                        })
                    }
                    // Handle nested lists inside <li>
                    for (const nested of child.childNodes) {
                        const nt = (nested.tagName || "").toLowerCase()
                        if (nt === "ol" || nt === "ul") {
                            walkNode(nested, depth + 1)
                        }
                    }
                }
            }
            return
        }

        // ── Unordered lists ──
        if (tag === "ul") {
            for (const child of node.childNodes) {
                const childTag = (child.tagName || "").toLowerCase()
                if (childTag === "li") {
                    const text = cleanTextWithInlineCode(child)
                    if (text) {
                        paragraphs.push({
                            type: "list-item",
                            text,
                            indent: depth,
                            ordered: false,
                        })
                    }
                    // Handle nested lists inside <li>
                    for (const nested of child.childNodes) {
                        const nt = (nested.tagName || "").toLowerCase()
                        if (nt === "ol" || nt === "ul") {
                            walkNode(nested, depth + 1)
                        }
                    }
                }
            }
            return
        }

        // ── Container elements — recurse into children ──
        const containerTags = ["section", "article", "div", "main", "aside", "figure", "nav", "header", "footer", "details", "summary"]
        if (containerTags.includes(tag)) {
            for (const child of node.childNodes) {
                walkNode(child, depth)
            }
            return
        }

        // ── Leaf-level text blocks — extract text directly ──
        const leafTags = ["p", "dd", "dt", "td", "th", "figcaption", "caption", "address"]
        if (leafTags.includes(tag)) {
            const text = cleanTextWithInlineCode(node)
            if (text) {
                paragraphs.push({ type: "paragraph", text })
            }
            return
        }

        // ── <br> creates a line break ──
        if (tag === "br") {
            paragraphs.push({ type: "paragraph", text: "" })
            return
        }

        // Recurse into children for structural elements (body, main, etc.)
        for (const child of node.childNodes) {
            walkNode(child, depth)
        }
    }

    walkNode(root, 0)

    // If no structured content found, split by double newlines / periods
    if (paragraphs.length === 0) {
        const text = cleanText(root.textContent)
        if (text) {
            const lines = text.split(/\n{2,}/)
            if (lines.length > 1) {
                for (const line of lines) {
                    const trimmed = line.trim()
                    if (trimmed) {
                        paragraphs.push({ type: "paragraph", text: trimmed })
                    }
                }
            } else {
                const sentences = splitIntoReadableParagraphs(text)
                for (const sentence of sentences) {
                    paragraphs.push({ type: "paragraph", text: sentence })
                }
            }
        }
    }

    return paragraphs
}

/**
 * Extract text from a node while preserving inline <code> markers.
 * Inline code is surrounded by ` backtick markers for rendering.
 */
function cleanTextWithInlineCode(node: any): string {
    const parts: string[] = []

    function walk(n: any) {
        if (n.nodeType === 3) {
            // Text node
            parts.push(n.rawText || n.textContent || "")
            return
        }
        const tag = (n.tagName || "").toLowerCase()

        // Inline code: wrap in backticks for terminal styling
        if (tag === "code" || tag === "samp" || tag === "var") {
            const text = n.textContent?.trim()
            if (text) {
                parts.push(`\`${text}\``)
                return
            }
        }

        // <kbd> for keyboard shortcuts
        if (tag === "kbd") {
            const text = n.textContent?.trim()
            if (text) {
                parts.push(`[${text}]`)
                return
            }
        }

        // <strong> / <b> markup
        if (tag === "strong" || tag === "b") {
            parts.push(n.textContent || "")
            return
        }

        // <em> / <i> markup
        if (tag === "em" || tag === "i") {
            parts.push(n.textContent || "")
            return
        }

        // <a> links — include text
        if (tag === "a") {
            parts.push(n.textContent || "")
            return
        }

        // Skip images, scripts, styles
        if (tag === "img" || tag === "script" || tag === "style") return

        // Recurse
        for (const child of n.childNodes || []) {
            walk(child)
        }
    }

    walk(node)
    return cleanText(parts.join(""))
}

/**
 * Split a long text blob into readable paragraph-sized chunks
 * at sentence boundaries (. ! ? followed by space + capital letter)
 */
function splitIntoReadableParagraphs(text: string, maxLen: number = 500): string[] {
    if (text.length <= maxLen) return [text]

    const result: string[] = []
    let remaining = text

    while (remaining.length > maxLen) {
        let splitAt = -1
        for (let i = maxLen; i > maxLen * 0.4; i--) {
            const ch = remaining[i]
            if ((ch === "." || ch === "!" || ch === "?") && remaining[i + 1] === " ") {
                splitAt = i + 1
                break
            }
        }

        if (splitAt === -1) {
            for (let i = maxLen; i > maxLen * 0.5; i--) {
                if (remaining[i] === " ") {
                    splitAt = i
                    break
                }
            }
        }

        if (splitAt === -1) splitAt = maxLen

        result.push(remaining.slice(0, splitAt).trim())
        remaining = remaining.slice(splitAt).trim()
    }

    if (remaining.trim()) result.push(remaining.trim())
    return result
}

/**
 * Clean whitespace from extracted text
 */
function cleanText(raw: string): string {
    return raw
        .replace(/\s+/g, " ")
        .trim()
}

/**
 * Wrap text to a given width, respecting word boundaries
 */
export function wordWrap(text: string, width: number): string[] {
    if (width <= 0 || text.length <= width) return [text]
    const words = text.split(/\s+/)
    const lines: string[] = []
    let currentLine = ""

    for (const word of words) {
        if (currentLine.length === 0) {
            currentLine = word
        } else if (currentLine.length + 1 + word.length <= width) {
            currentLine += " " + word
        } else {
            lines.push(currentLine)
            currentLine = word
        }
    }
    if (currentLine) lines.push(currentLine)
    return lines.length > 0 ? lines : [""]
}

/**
 * Format a table for terminal rendering.
 * Returns an array of lines with box-drawing characters.
 */
export function formatTable(rows: string[][]): string {
    if (rows.length === 0) return ""

    // Calculate column widths
    const colCount = Math.max(...rows.map(r => r.length))
    const colWidths: number[] = Array(colCount).fill(0)

    for (const row of rows) {
        for (let c = 0; c < row.length; c++) {
            colWidths[c] = Math.max(colWidths[c]!, (row[c]?.length || 0) + 2)
        }
    }

    // Cap columns at 30 chars
    for (let c = 0; c < colWidths.length; c++) {
        colWidths[c] = Math.min(colWidths[c]!, 30)
    }

    const lines: string[] = []
    const topBorder = "┌" + colWidths.map(w => "─".repeat(w)).join("┬") + "┐"
    const midBorder = "├" + colWidths.map(w => "─".repeat(w)).join("┼") + "┤"
    const botBorder = "└" + colWidths.map(w => "─".repeat(w)).join("┴") + "┘"

    lines.push(topBorder)

    for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!
        const cells = colWidths.map((w, c) => {
            const cell = (row[c] || "").slice(0, w - 2)
            return " " + cell.padEnd(w - 1)
        })
        lines.push("│" + cells.join("│") + "│")

        if (r === 0 && rows.length > 1) {
            lines.push(midBorder) // Header separator
        }
    }

    lines.push(botBorder)
    return lines.join("\n")
}
