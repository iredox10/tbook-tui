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
    imageMap: Map<string, Buffer> // src URL -> image data
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
    const tocLookup = buildTocLookup(epub)

    for (let i = 0; i < flow.length; i++) {
        const item = flow[i]
        try {
            const html = await getChapterContent(epub, item.id)
            const paragraphs = htmlToStyledParagraphs(html)

            // Count words
            const wordCount = paragraphs.reduce((sum, p) => {
                return sum + p.text.split(/\s+/).filter(Boolean).length
            }, 0)

            // Count images
            const imageCount = paragraphs.filter(p => p.type === "image").length

            // Skip truly empty chapters (no text AND no images)
            if (wordCount < 5 && paragraphs.length < 2 && imageCount === 0) continue

            // Prefer in-chapter heading/title first so displayed title matches visible content.
            // Fall back to TOC mapping when chapter content has no usable heading.
            const tocTitle = deriveChapterTitleFromParagraphs(paragraphs)
                || findTocTitle(epub, item.id, tocLookup)
                || `Chapter ${chapters.length + 1}`

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

    // Extract images from the epub manifest
    const imageMap = new Map<string, Buffer>()
    const manifest = epub.manifest || {}
    const imageIds = Object.keys(manifest).filter(id => {
        const mediaType = (manifest[id]?.['media-type'] || '').toLowerCase()
        return mediaType.startsWith('image/')
    })

    // Extract each image (non-blocking, best-effort)
    await Promise.allSettled(
        imageIds.map(id => new Promise<void>((resolve) => {
            try {
                epub.getImage(id, (err: Error | null, data: Buffer, mimeType: string) => {
                    if (!err && data) {
                        const href = manifest[id]?.href || ''
                        // Store with multiple possible key formats
                        imageMap.set(href, data)
                        // epub2 rewrites src to /images/id/path
                        imageMap.set(`/images/${id}/${href}`, data)
                        // Also store by just the filename part
                        const fileName = href.split('/').pop() || ''
                        if (fileName) imageMap.set(fileName, data)
                    }
                    resolve()
                })
            } catch {
                resolve()
            }
        }))
    )

    return { metadata, chapters, totalWords, imageMap }
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

function normalizeHref(href: string | undefined): string {
    if (!href) return ""
    return decodeURIComponent(href)
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, "")
        .split("#")[0]!
        .trim()
        .toLowerCase()
}

function getHrefBaseName(normalizedHref: string): string {
    const idx = normalizedHref.lastIndexOf("/")
    return idx >= 0 ? normalizedHref.slice(idx + 1) : normalizedHref
}

function flattenToc(toc: any[]): any[] {
    const out: any[] = []
    const visit = (entry: any) => {
        if (!entry) return
        out.push(entry)
        const children = entry.subitems || entry.children || entry.items || []
        if (Array.isArray(children)) {
            for (const child of children) visit(child)
        }
    }
    for (const entry of toc || []) visit(entry)
    return out
}

function buildTocLookup(epub: any): { byId: Map<string, string>; byHref: Map<string, string>; byBaseName: Map<string, string> } {
    const byId = new Map<string, string>()
    const byHref = new Map<string, string>()
    const byBaseName = new Map<string, string>()
    const flatToc = flattenToc(epub.toc || [])

    for (const entry of flatToc) {
        const title = (entry?.title || "").trim()
        if (!title) continue

        const id = (entry?.id || "").trim()
        if (id) byId.set(id, title)

        const href = normalizeHref(entry?.href)
        if (href) {
            byHref.set(href, title)
            byBaseName.set(getHrefBaseName(href), title)
        }
    }

    return { byId, byHref, byBaseName }
}

function deriveChapterTitleFromParagraphs(paragraphs: StyledParagraph[]): string | null {
    for (const p of paragraphs) {
        if (p.type === "heading" && p.text?.trim()) {
            return p.text.trim()
        }
    }
    for (const p of paragraphs) {
        const text = (p.text || "").trim()
        if (!text) continue
        if (p.type === "paragraph" || p.type === "quote") {
            return text.length > 80 ? `${text.slice(0, 77)}...` : text
        }
    }
    return null
}

/**
 * Find a chapter title from the TOC by matching IDs
 */
function findTocTitle(
    epub: any,
    itemId: string,
    lookup: { byId: Map<string, string>; byHref: Map<string, string>; byBaseName: Map<string, string> },
): string | null {
    if (lookup.byId.has(itemId)) return lookup.byId.get(itemId) || null

    const itemHref = normalizeHref(epub.manifest?.[itemId]?.href)
    if (!itemHref) return null

    if (lookup.byHref.has(itemHref)) return lookup.byHref.get(itemHref) || null

    const baseName = getHrefBaseName(itemHref)
    if (lookup.byBaseName.has(baseName)) return lookup.byBaseName.get(baseName) || null

    for (const [tocHref, title] of lookup.byHref) {
        if (tocHref.endsWith(`/${baseName}`) || itemHref.endsWith(`/${getHrefBaseName(tocHref)}`)) {
            return title
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
