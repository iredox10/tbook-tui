// ─────────────────────────────────────────────────────────────
// EPUB Parser — extracts chapters, metadata, and content
// ─────────────────────────────────────────────────────────────

import EPub from "epub2"
import { htmlToStyledParagraphs, type StyledParagraph } from "../utils/html-to-text"

export interface BookMetadata {
    title: string
    author: string
    description?: string
    publisher?: string
    language?: string
    cover?: Buffer
}

export interface Chapter {
    id: string
    title: string
    order: number
    paragraphs: StyledParagraph[]
    wordCount: number
}

export interface ParsedBook {
    metadata: BookMetadata
    chapters: Chapter[]
    totalWords: number
}

/**
 * Parse an EPUB file and extract structured book data
 */
export async function parseEpub(filePath: string): Promise<ParsedBook> {
    const epub = await EPub.createAsync(filePath)

    // Extract metadata
    const metadata: BookMetadata = {
        title: epub.metadata?.title || "Untitled",
        author: epub.metadata?.creator || "Unknown",
        description: epub.metadata?.description || undefined,
        publisher: epub.metadata?.publisher || undefined,
        language: epub.metadata?.language || undefined,
    }

    // Extract chapters from the table of contents / spine
    const chapters: Chapter[] = []
    const flow = epub.flow || []

    for (let i = 0; i < flow.length; i++) {
        const item = flow[i]
        try {
            const html = await getChapterContent(epub, item.id)
            const paragraphs = htmlToStyledParagraphs(html)

            // Count words
            const wordCount = paragraphs.reduce((sum, p) => {
                return sum + p.text.split(/\s+/).filter(Boolean).length
            }, 0)

            // Skip empty chapters (often just images or blank pages)
            if (wordCount < 5 && paragraphs.length < 2) continue

            // Try to get a title from the TOC
            const tocTitle = findTocTitle(epub, item.id) || `Chapter ${chapters.length + 1}`

            chapters.push({
                id: item.id,
                title: tocTitle,
                order: chapters.length,
                paragraphs,
                wordCount,
            })
        } catch (err) {
            // Skip chapters that fail to parse
            continue
        }
    }

    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)

    return { metadata, chapters, totalWords }
}

/**
 * Get raw HTML content of a chapter by ID
 */
function getChapterContent(epub: any, chapterId: string): Promise<string> {
    return new Promise((resolve, reject) => {
        epub.getChapter(chapterId, (err: Error | null, text: string) => {
            if (err) reject(err)
            else resolve(text || "")
        })
    })
}

/**
 * Find a chapter title from the TOC by matching IDs
 */
function findTocTitle(epub: any, itemId: string): string | null {
    const toc = epub.toc || []

    for (const entry of toc) {
        // TOC href might include fragment (#xxx) - compare base
        const tocHref = (entry.href || "").split("#")[0]
        const manifest = epub.manifest?.[itemId]
        const itemHref = manifest?.href || ""

        if (tocHref === itemHref || entry.id === itemId) {
            return entry.title || null
        }
    }

    return null
}

/**
 * Get a single chapter by index (lazy loading)
 */
export async function getChapter(filePath: string, chapterIndex: number): Promise<Chapter | null> {
    const book = await parseEpub(filePath)
    return book.chapters[chapterIndex] || null
}
