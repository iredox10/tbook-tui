// ─────────────────────────────────────────────────────────────
// Export Service — Obsidian/Logseq markdown export
// ─────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"
import { getBookmarks, type BookmarkRecord, type BookRecord } from "./database"
import type { ParsedBook } from "./epub-parser"

export interface ExportOptions {
    format: "obsidian" | "logseq"
    outputDir: string
    includeBookmarks: boolean
    includeHighlights: boolean
    includeMetadata: boolean
}

const defaultOptions: ExportOptions = {
    format: "obsidian",
    outputDir: join(homedir(), "Documents", "TBook Export"),
    includeBookmarks: true,
    includeHighlights: true,
    includeMetadata: true,
}

/**
 * Export a book's notes and bookmarks as markdown
 */
export function exportBook(
    book: BookRecord,
    parsedBook: ParsedBook,
    options: Partial<ExportOptions> = {},
): { path: string; success: boolean; error?: string } {
    const opts = { ...defaultOptions, ...options }

    try {
        // Ensure output directory exists
        if (!existsSync(opts.outputDir)) {
            mkdirSync(opts.outputDir, { recursive: true })
        }

        const bookmarks = opts.includeBookmarks ? getBookmarks(book.id) : []
        const safeTitle = book.title.replace(/[/\\:*?"<>|]/g, "-").trim()
        const fileName = `${safeTitle}.md`
        const filePath = join(opts.outputDir, fileName)

        let content = ""

        // ── YAML Frontmatter ──
        if (opts.includeMetadata) {
            content += "---\n"
            content += `title: "${book.title}"\n`
            content += `author: "${book.author}"\n`
            content += `format: ${book.format}\n`
            content += `chapters: ${book.total_chapters}\n`
            content += `progress: ${book.total_chapters > 0
                ? Math.round((book.current_chapter / book.total_chapters) * 100)
                : 0}%\n`
            content += `last_read: ${book.last_read_at || "never"}\n`
            content += `exported: ${new Date().toISOString().slice(0, 10)}\n`

            if (opts.format === "obsidian") {
                content += `tags:\n  - book\n  - reading\n`
                content += `aliases:\n  - "${book.title}"\n`
            }

            content += "---\n\n"
        }

        // ── Title ──
        content += `# 📖 ${book.title}\n\n`
        content += `**Author:** ${book.author}  \n`
        content += `**Format:** ${book.format.toUpperCase()}  \n`

        const progress = book.total_chapters > 0
            ? Math.round((book.current_chapter / book.total_chapters) * 100)
            : 0
        content += `**Progress:** ${progress}% (Chapter ${book.current_chapter + 1}/${book.total_chapters})  \n`
        content += `**Exported:** ${new Date().toLocaleDateString()}\n\n`

        content += "---\n\n"

        // ── Table of Contents ──
        content += "## 📑 Chapters\n\n"
        for (let i = 0; i < parsedBook.chapters.length; i++) {
            const ch = parsedBook.chapters[i]!
            const isCurrent = i === book.current_chapter
            const marker = isCurrent ? "📍" : "-"
            const wordCount = ch.wordCount > 0 ? ` *(${(ch.wordCount / 1000).toFixed(1)}k words)*` : ""
            content += `${marker} ${opts.format === "logseq" ? "" : ""}**Chapter ${i + 1}:** ${ch.title}${wordCount}\n`
        }
        content += "\n"

        // ── Bookmarks ──
        if (bookmarks.length > 0) {
            content += "## 🔖 Bookmarks\n\n"

            // Group bookmarks by chapter
            const byChapter = new Map<number, BookmarkRecord[]>()
            for (const bm of bookmarks) {
                const list = byChapter.get(bm.chapter) || []
                list.push(bm)
                byChapter.set(bm.chapter, list)
            }

            for (const [chapterIdx, bms] of byChapter) {
                const chTitle = parsedBook.chapters[chapterIdx]?.title || `Chapter ${chapterIdx + 1}`
                content += `### Ch. ${chapterIdx + 1}: ${chTitle}\n\n`

                for (const bm of bms) {
                    const label = bm.label || `Position ${bm.scroll_position}`
                    const date = bm.created_at ? new Date(bm.created_at).toLocaleDateString() : ""
                    content += `- 🔖 ${label}`
                    if (date) content += ` *(${date})*`
                    content += "\n"
                }
                content += "\n"
            }
        }

        // ── Reading Notes section (empty template) ──
        content += "## 📝 Notes\n\n"
        content += "> Add your reading notes here...\n\n"

        // ── Logseq format: add block references ──
        if (opts.format === "logseq") {
            content += "## Reading Log\n\n"
            content += `- Started reading:: ${book.created_at?.slice(0, 10) || "unknown"}\n`
            content += `- Last read:: ${book.last_read_at?.slice(0, 10) || "unknown"}\n`
            content += `- Status:: ${progress >= 100 ? "completed" : "reading"}\n`
        }

        writeFileSync(filePath, content, "utf-8")

        return { path: filePath, success: true }
    } catch (err) {
        return {
            path: "",
            success: false,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}

/**
 * Get default export directory
 */
export function getExportDir(): string {
    return defaultOptions.outputDir
}
