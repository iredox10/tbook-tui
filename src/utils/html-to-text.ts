// ─────────────────────────────────────────────────────────────
// HTML → Styled paragraphs for terminal rendering
// ─────────────────────────────────────────────────────────────

import { parse as parseHTML } from "node-html-parser"

export interface StyledParagraph {
    type: "heading" | "paragraph" | "quote" | "separator" | "list-item" | "code"
    text: string
    level?: number  // heading level (1-6)
    indent?: number // nesting depth for lists
    ordered?: boolean // numbered list?
    index?: number  // list item index (for ordered lists)
}

/**
 * Convert an HTML chapter string into an array of styled paragraphs.
 * Handles headings, paragraphs, lists, blockquotes, code blocks, and more.
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
            const text = cleanText(node.textContent)
            if (text) {
                paragraphs.push({ type: "quote", text })
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
            const text = node.textContent?.trim() || ""
            if (text) {
                paragraphs.push({ type: "code", text })
            }
            return
        }

        // ── Ordered lists ──
        if (tag === "ol") {
            let itemIndex = 0
            for (const child of node.childNodes) {
                const childTag = (child.tagName || "").toLowerCase()
                if (childTag === "li") {
                    itemIndex++
                    const text = cleanText(child.textContent)
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
                    const text = cleanText(child.textContent)
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
            const text = cleanText(node.textContent)
            if (text) {
                paragraphs.push({ type: "paragraph", text })
            }
            return
        }

        // ── <br> creates a line break ──
        if (tag === "br") {
            // Add empty paragraph for spacing
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
            // Try splitting by newlines first
            const lines = text.split(/\n{2,}/)
            if (lines.length > 1) {
                for (const line of lines) {
                    const trimmed = line.trim()
                    if (trimmed) {
                        paragraphs.push({ type: "paragraph", text: trimmed })
                    }
                }
            } else {
                // If no double-newlines, split very long text at sentence boundaries
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
 * Split a long text blob into readable paragraph-sized chunks
 * at sentence boundaries (. ! ? followed by space + capital letter)
 */
function splitIntoReadableParagraphs(text: string, maxLen: number = 500): string[] {
    if (text.length <= maxLen) return [text]

    const result: string[] = []
    let remaining = text

    while (remaining.length > maxLen) {
        // Find a sentence boundary near maxLen
        let splitAt = -1
        // Search backwards from maxLen for a sentence end
        for (let i = maxLen; i > maxLen * 0.4; i--) {
            const ch = remaining[i]
            if ((ch === "." || ch === "!" || ch === "?") && remaining[i + 1] === " ") {
                splitAt = i + 1
                break
            }
        }

        if (splitAt === -1) {
            // No sentence boundary found — split at maxLen on a space
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
