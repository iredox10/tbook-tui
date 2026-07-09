// ─────────────────────────────────────────────────────────────
// HTML → Styled paragraphs for terminal rendering
// Enhanced for programming books: code blocks, inline code,
// tables, definition lists, and more.
// ─────────────────────────────────────────────────────────────

import { parse as parseHTML } from "node-html-parser"

export interface StyledParagraph {
    type: "heading" | "paragraph" | "quote" | "separator" | "list-item" | "code" | "table" | "note" | "footnote" | "image"
    text: string
    level?: number  // heading level (1-6)
    indent?: number // nesting depth for lists
    ordered?: boolean // numbered list?
    index?: number  // list item index (for ordered lists)
    language?: string // programming language for code blocks
    tableRows?: string[][] // parsed table data for table type
    noteKind?: "tip" | "warning" | "note" | "important" // callout type
    footnoteRef?: string // footnote reference ID
    imageSrc?: string // image source path/URL
    imageAlt?: string // image alt text
    inlineSpans?: InlineSpan[] // tokenized inline formatting (bold, italic, code, links)
}

export interface InlineSpan {
    text: string
    bold?: boolean
    italic?: boolean
    code?: boolean
    link?: string
}

function getSemanticTokens(node: any): string[] {
    const epubType = (node.getAttribute?.("epub:type") || "").toLowerCase()
    const role = (node.getAttribute?.("role") || "").toLowerCase()
    const cls = (node.getAttribute?.("class") || "").toLowerCase()
    const combined = `${epubType} ${role} ${cls}`.trim()
    return combined ? combined.split(/\s+/).filter(Boolean) : []
}

function hasSemantic(node: any, ...tokens: string[]): boolean {
    const set = new Set(getSemanticTokens(node))
    return tokens.some(token => set.has(token.toLowerCase()))
}

function semanticHeadingLabel(node: any): string | null {
    const direct = cleanText(node.getAttribute?.("title") || node.getAttribute?.("aria-label") || "")
    if (direct) return direct

    for (const child of node.childNodes || []) {
        const tag = (child.tagName || "").toLowerCase()
        if (/^h[1-6]$/.test(tag)) {
            const txt = cleanText(child.textContent || "")
            if (txt) return txt
        }
    }

    const txt = cleanText(node.textContent || "")
    if (!txt) return null
    return txt.length > 70 ? txt.slice(0, 67).trimEnd() + "..." : txt
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

        // ── EPUB semantic structure (epub:type/ARIA role) ──
        if (hasSemantic(node, "doc-pagebreak", "pagebreak")) {
            const label = cleanText(node.getAttribute?.("title") || node.getAttribute?.("aria-label") || node.textContent || "")
            paragraphs.push({ type: "separator", text: label ? `Page break: ${label}` : "" })
            return
        }

        if (
            ["section", "article", "div", "main", "nav"].includes(tag) &&
            hasSemantic(
                node,
                "chapter", "part", "appendix", "foreword", "preface", "prologue",
                "epilogue", "conclusion", "index", "bibliography",
            )
        ) {
            const hasExplicitHeading = !!node.querySelector?.("h1, h2, h3, h4, h5, h6")
            if (!hasExplicitHeading) {
                const heading = semanticHeadingLabel(node)
                if (heading) {
                    paragraphs.push({ type: "heading", text: heading, level: 1 })
                }
            }
        }

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

        // ── Footnotes (aside/section with epub:type or role) ──
        if ((tag === "aside" || tag === "section" || tag === "div") &&
            (hasSemantic(node, "footnote", "endnote", "doc-footnote", "doc-endnote") ||
                node.getAttribute?.("role") === "doc-footnote" ||
                node.getAttribute?.("role") === "doc-endnote")) {
            const id = node.getAttribute?.("id") || ""
            const text = cleanText(node.textContent)
            if (text) {
                paragraphs.push({ type: "footnote", text, footnoteRef: id })
            }
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
                    const result = cleanTextWithInlineSpans(child)
                    if (result.text) {
                        paragraphs.push({
                            type: "list-item",
                            text: result.text,
                            indent: depth,
                            ordered: true,
                            index: itemIndex,
                            inlineSpans: result.spans,
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
                    const result = cleanTextWithInlineSpans(child)
                    if (result.text) {
                        paragraphs.push({
                            type: "list-item",
                            text: result.text,
                            indent: depth,
                            ordered: false,
                            inlineSpans: result.spans,
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
        const containerTags = ["section", "article", "div", "main", "aside", "nav", "header", "footer", "details", "summary"]
        if (containerTags.includes(tag)) {
            // Skip navigational landmark blocks that are usually boilerplate TOC fragments
            if (tag === "nav" && hasSemantic(node, "toc", "landmarks")) {
                return
            }
            for (const child of node.childNodes) {
                walkNode(child, depth)
            }
            return
        }

        // ── Figure — extract images and captions ──
        if (tag === "figure") {
            // Look for an img inside the figure
            const imgNode = node.querySelector?.("img") || node.querySelector?.("image")
            if (imgNode) {
                const src = imgNode.getAttribute?.("src") || imgNode.getAttribute?.("xlink:href") || ""
                const alt = imgNode.getAttribute?.("alt") || ""
                const caption = node.querySelector?.("figcaption")?.textContent?.trim() || ""
                const displayText = caption || alt || "[Image]"
                paragraphs.push({ type: "image", text: displayText, imageSrc: src, imageAlt: alt })
                return
            }
            // No img found, recurse normally
            for (const child of node.childNodes) {
                walkNode(child, depth)
            }
            return
        }

        // ── Standalone img tags at block level ──
        if (tag === "img" || tag === "image") {
            const src = node.getAttribute?.("src") || node.getAttribute?.("xlink:href") || ""
            const alt = node.getAttribute?.("alt") || "[Image]"
            if (src) {
                paragraphs.push({ type: "image", text: alt, imageSrc: src, imageAlt: alt })
            }
            return
        }

        // ── SVG (may contain images) ──
        if (tag === "svg") {
            const imgInSvg = node.querySelector?.("image")
            if (imgInSvg) {
                const href = imgInSvg.getAttribute?.("xlink:href") || imgInSvg.getAttribute?.("href") || ""
                if (href) {
                    paragraphs.push({ type: "image", text: "[SVG Image]", imageSrc: href, imageAlt: "" })
                }
            }
            return
        }

        // ── Leaf-level text blocks — extract text directly ──
        const leafTags = ["p", "dd", "dt", "td", "th", "figcaption", "caption", "address"]
        if (leafTags.includes(tag)) {
            const result = cleanTextWithInlineSpans(node)
            if (result.text) {
                paragraphs.push({ type: "paragraph", text: result.text, inlineSpans: result.spans })
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
 * Extract text from a node while preserving inline formatting as tokenized spans.
 * Returns both plain text (for search/indexing) and structured spans (for rich rendering).
 * Supports nested bold, italic, code, and links without marker loss.
 */
export function cleanTextWithInlineSpans(node: any): { text: string; spans: InlineSpan[] } {
    const spans: InlineSpan[] = []

    function walk(n: any, bold: boolean, italic: boolean, code: boolean, link: string | null) {
        if (n.nodeType === 3) {
            const text = (n.rawText || n.textContent || "")
            if (text) {
                spans.push({ text, bold: bold || undefined, italic: italic || undefined, code: code || undefined, link: link || undefined })
            }
            return
        }
        const tag = (n.tagName || "").toLowerCase()

        if (tag === "strong" || tag === "b") {
            for (const child of n.childNodes || []) walk(child, true, italic, code, link)
            return
        }
        if (tag === "em" || tag === "i") {
            for (const child of n.childNodes || []) walk(child, bold, true, code, link)
            return
        }
        if (tag === "code" || tag === "samp" || tag === "var") {
            for (const child of n.childNodes || []) walk(child, bold, italic, true, link)
            return
        }
        if (tag === "a") {
            const href = n.getAttribute?.("href") || ""
            if (hasSemantic(n, "noteref", "doc-noteref") || n.getAttribute?.("role") === "doc-noteref") {
                const ref = href.replace(/^#/, "") || ""
                if (ref) {
                    spans.push({ text: `[^${ref}]`, bold: bold || undefined })
                    return
                }
            }
            for (const child of n.childNodes || []) walk(child, bold, italic, code, href || null)
            return
        }
        if (tag === "kbd") {
            const text = n.textContent?.trim() || ""
            if (text) spans.push({ text: `[${text}]` })
            return
        }
        if (tag === "img" || tag === "image") {
            const alt = n.getAttribute?.("alt") || "[Image]"
            spans.push({ text: `[${alt}]` })
            return
        }
        if (tag === "sup") {
            for (const child of n.childNodes || []) walk(child, bold, italic, code, link)
            return
        }
        if (tag === "script" || tag === "style") return

        for (const child of n.childNodes || []) walk(child, bold, italic, code, link)
    }

    walk(node, false, false, false, null)

    // Merge adjacent spans with identical styling
    const merged: InlineSpan[] = []
    for (const s of spans) {
        if (s.text === "") continue
        const prev = merged[merged.length - 1]
        if (prev &&
            prev.bold === s.bold &&
            prev.italic === s.italic &&
            prev.code === s.code &&
            prev.link === s.link) {
            prev.text += s.text
        } else {
            merged.push({ ...s })
        }
    }

    const plainText = cleanText(merged.map(s => s.text).join(""))

    return { text: plainText, spans: merged.length > 0 ? merged : undefined as any }
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
