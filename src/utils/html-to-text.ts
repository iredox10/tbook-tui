// ─────────────────────────────────────────────────────────────
// HTML → Styled paragraphs for terminal rendering
// ─────────────────────────────────────────────────────────────

import { parse as parseHTML } from "node-html-parser"

export interface StyledParagraph {
    type: "heading" | "paragraph" | "quote" | "separator"
    text: string
    level?: number // heading level (1-6)
}

/**
 * Convert an HTML chapter string into an array of styled paragraphs.
 * Strips all tags and extracts text with semantic type info.
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

    const blockTags = ["p", "div", "section", "article", "li", "dd", "dt", "td"]
    const headingTags = ["h1", "h2", "h3", "h4", "h5", "h6"]

    function walkNode(node: any) {
        if (node.nodeType === 3) {
            // Text node — handled by parent
            return
        }

        const tag = (node.tagName || "").toLowerCase()

        // Headings
        if (headingTags.includes(tag)) {
            const text = cleanText(node.textContent)
            if (text) {
                paragraphs.push({
                    type: "heading",
                    text,
                    level: parseInt(tag[1]),
                })
            }
            return
        }

        // Blockquotes
        if (tag === "blockquote") {
            const text = cleanText(node.textContent)
            if (text) {
                paragraphs.push({ type: "quote", text })
            }
            return
        }

        // HR / separators
        if (tag === "hr") {
            paragraphs.push({ type: "separator", text: "" })
            return
        }

        // Block-level text elements
        if (blockTags.includes(tag)) {
            const text = cleanText(node.textContent)
            if (text) {
                paragraphs.push({ type: "paragraph", text })
            }
            return
        }

        // Recurse into children for structural elements
        for (const child of node.childNodes) {
            walkNode(child)
        }
    }

    walkNode(root)

    // If no structured content found, split by line breaks
    if (paragraphs.length === 0) {
        const text = cleanText(root.textContent)
        if (text) {
            const lines = text.split(/\n+/)
            for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed) {
                    paragraphs.push({ type: "paragraph", text: trimmed })
                }
            }
        }
    }

    return paragraphs
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
    if (width <= 0) return [text]
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
