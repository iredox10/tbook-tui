// ─────────────────────────────────────────────────────────────
// PDF Parser — extracts text from PDF files via pdftotext
// ─────────────────────────────────────────────────────────────

import { execSync } from "child_process"
import { existsSync } from "fs"
import { htmlToStyledParagraphs, type StyledParagraph } from "../utils/html-to-text"
import type { BookMetadata, Chapter, ParsedBook } from "./epub-parser"

/**
 * Check if pdftotext is available on the system
 */
export function hasPdfSupport(): boolean {
    try {
        execSync("pdftotext -v 2>&1", { stdio: "pipe" })
        return true
    } catch {
        // pdftotext outputs version to stderr and exits 0 or 99
        try {
            execSync("which pdftotext", { stdio: "pipe" })
            return true
        } catch {
            return false
        }
    }
}

/**
 * Get total page count of a PDF
 */
function getPdfPageCount(filePath: string): number {
    try {
        const output = execSync(`pdftotext -l 1 "${filePath}" - 2>/dev/null | wc -c`, {
            stdio: "pipe",
            encoding: "utf-8" as BufferEncoding,
        })
        // Use pdfinfo if available
        try {
            const info = execSync(`pdfinfo "${filePath}" 2>/dev/null`, {
                stdio: "pipe",
                encoding: "utf-8",
            })
            const match = info.match(/Pages:\s+(\d+)/)
            if (match) return parseInt(match[1])
        } catch { }
        return 0
    } catch {
        return 0
    }
}

/**
 * Extract text from a range of pages
 */
function extractPages(filePath: string, startPage: number, endPage: number): string {
    try {
        const output = execSync(
            `pdftotext -f ${startPage} -l ${endPage} -layout "${filePath}" -`,
            { stdio: "pipe", encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
        )
        return output
    } catch {
        return ""
    }
}

/**
 * Split raw text into paragraphs
 */
function textToParagraphs(text: string): StyledParagraph[] {
    const paragraphs: StyledParagraph[] = []
    // Split by double newlines for paragraph breaks
    const blocks = text.split(/\n{2,}/)

    for (const block of blocks) {
        const trimmed = block.replace(/\s+/g, " ").trim()
        if (!trimmed || trimmed.length < 2) continue

        // Detect headings (all caps, short line)
        if (trimmed === trimmed.toUpperCase() && trimmed.length < 60 && !trimmed.match(/^\d/)) {
            paragraphs.push({ type: "heading", text: trimmed, level: 2 })
        } else {
            paragraphs.push({ type: "paragraph", text: trimmed })
        }
    }

    return paragraphs
}

/**
 * Parse a PDF file into structured book data.
 * Groups pages into "chapters" of ~10 pages each for navigation.
 */
export async function parsePdf(filePath: string): Promise<ParsedBook> {
    if (!hasPdfSupport()) {
        throw new Error(
            "pdftotext not found. Install poppler-utils:\n  sudo apt install poppler-utils",
        )
    }

    const totalPages = getPdfPageCount(filePath)

    // Extract metadata from filename
    const basename = filePath.split("/").pop() || "Untitled"
    const title = basename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ")

    const metadata: BookMetadata = {
        title,
        author: "Unknown",
        description: undefined,
    }

    // Group pages into chapters of ~10 pages each
    const chunkSize = 10
    const chapters: Chapter[] = []
    const numChunks = totalPages > 0 ? Math.ceil(totalPages / chunkSize) : 1

    if (totalPages === 0) {
        // Couldn't determine page count — extract everything as one chapter
        const text = extractPages(filePath, 1, 99999)
        const paragraphs = textToParagraphs(text)
        const wordCount = paragraphs.reduce(
            (sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length, 0,
        )
        chapters.push({
            id: "ch-0",
            title: "Full Document",
            order: 0,
            paragraphs,
            wordCount,
        })
    } else {
        for (let i = 0; i < numChunks; i++) {
            const startPage = i * chunkSize + 1
            const endPage = Math.min((i + 1) * chunkSize, totalPages)

            const text = extractPages(filePath, startPage, endPage)
            const paragraphs = textToParagraphs(text)
            const wordCount = paragraphs.reduce(
                (sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length, 0,
            )

            // Skip truly empty sections
            if (wordCount < 3 && paragraphs.length < 1) continue

            chapters.push({
                id: `ch-${i}`,
                title: `Pages ${startPage}–${endPage}`,
                order: chapters.length,
                paragraphs,
                wordCount,
            })
        }
    }

    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)

    return { metadata, chapters, totalWords }
}
