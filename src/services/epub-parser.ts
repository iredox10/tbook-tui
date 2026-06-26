// ─────────────────────────────────────────────────────────────
// EPUB Parser — extracts chapters, metadata, and content
// ─────────────────────────────────────────────────────────────

import EPub from "epub2"
import { htmlToStyledParagraphs, type StyledParagraph } from "../utils/html-to-text"
import { createHash } from "crypto"
import { writeFileSync, existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

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
    sourceHref?: string // manifest href for relative asset resolution (images/links)
}

export interface ParsedBook {
    metadata: BookMetadata
    chapters: Chapter[]
    totalWords: number
    imageMap: Map<string, string> // src URL -> absolute file path
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

            if (isLikelyBoilerplateSection(tocTitle, paragraphs, wordCount)) {
                continue
            }

            chapters.push({
                id: item.id,
                title: tocTitle,
                order: chapters.length,
                paragraphs,
                wordCount,
                sourceHref: normalizeHref(epub.manifest?.[item.id]?.href || item.href || ""),
            })
        } catch (err) {
            // Skip chapters that fail to parse
            continue
        }
    }

    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)

    // Extract images from the epub manifest
    const imageMap = new Map<string, string>()
    const manifest = epub.manifest || {}
    const imageIds = Object.keys(manifest).filter(id => {
        const mediaType = (manifest[id]?.['media-type'] || '').toLowerCase()
        return mediaType.startsWith('image/')
    })

    const hash = createHash("md5").update(filePath).digest("hex")
    const cacheDir = join(homedir(), ".tbook", "cache", "images", hash)
    if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true })
    }

    const MAX_CONCURRENT = 5
    for (let i = 0; i < imageIds.length; i += MAX_CONCURRENT) {
        const batch = imageIds.slice(i, i + MAX_CONCURRENT)
        await Promise.allSettled(
            batch.map(id => new Promise<void>((resolve) => {
                try {
                    epub.getImage(id, (err: Error | null, data: Buffer, mimeType: string) => {
                        if (!err && data) {
                            const href = manifest[id]?.href || ''
                            const normalizedHref = normalizeHref(href)
                            const fileName = href.split('/').pop() || id
                            
                            const outPath = join(cacheDir, fileName)
                            try {
                                writeFileSync(outPath, data)
                            } catch (e) {
                                resolve()
                                return
                            }

                            // Store with multiple possible key formats
                            imageMap.set(href, outPath)
                            if (normalizedHref) imageMap.set(normalizedHref, outPath)

                            // epub2 rewrites src to /images/id/path
                            imageMap.set(`/images/${id}/${href}`, outPath)
                            if (normalizedHref) imageMap.set(`/images/${id}/${normalizedHref}`, outPath)

                            // Also store by just the filename part
                            const normalizedFileName = normalizedHref.split('/').pop() || ''
                            if (fileName) imageMap.set(fileName, outPath)
                            if (normalizedFileName) imageMap.set(normalizedFileName, outPath)
                        }
                        resolve()
                    })
                } catch {
                    resolve()
                }
            }))
        )
    }

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
    return null
}

function isLikelyBoilerplateSection(title: string, paragraphs: StyledParagraph[], wordCount: number): boolean {
    const normalizedTitle = (title || "").toLowerCase().trim()
    const joined = paragraphs.map(p => p.text || "").join(" ").toLowerCase()

    if (/(table of contents|contents|copyright|title page|about this book|imprint)/.test(normalizedTitle) && wordCount < 220) {
        return true
    }

    const tocLikeLines = paragraphs.filter(p => {
        const text = (p.text || "").trim()
        if (!text) return false
        return /\.{4,}\s*(\d+|[ivxlcdm]+)$/i.test(text) || /^\d+(?:\.\d+)*\s+.+/.test(text)
    }).length

    if (wordCount < 240 && tocLikeLines >= Math.max(3, Math.ceil(paragraphs.length * 0.35))) {
        return true
    }

    if (wordCount < 120 && /(all rights reserved|isbn|published by|cover design|printed in)/.test(joined)) {
        return true
    }

    return false
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
