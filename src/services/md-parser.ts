// ─────────────────────────────────────────────────────────────
// Markdown Parser — extracts chapters, metadata, and content
// ─────────────────────────────────────────────────────────────

import { readFileSync } from "fs"
import { basename } from "path"
import type { ParsedBook, Chapter, BookMetadata } from "./epub-parser"
import type { StyledParagraph } from "../utils/html-to-text"

export async function parseMd(filePath: string): Promise<ParsedBook> {
    const content = readFileSync(filePath, "utf-8")
    const ext = filePath.toLowerCase().endsWith(".txt") ? ".txt" : ".md"
    const title = basename(filePath, ext)
    
    const metadata: BookMetadata = {
        title: title,
        author: "Unknown"
    }

    const lines = content.split(/\r?\n/)
    
    let currentChapter: Chapter | null = null
    const chapters: Chapter[] = []
    let pList: StyledParagraph[] = []
    
    let inCodeBlock = false
    let codeLanguage = ""
    let codeContent: string[] = []

    function pushChapter() {
        if (!currentChapter) return
        currentChapter.paragraphs = pList
        currentChapter.wordCount = pList.reduce((sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length, 0)
        chapters.push(currentChapter)
        pList = []
    }

    function newChapter(chTitle: string) {
        pushChapter()
        currentChapter = {
            id: `ch-${chapters.length}`,
            title: chTitle,
            order: chapters.length,
            paragraphs: [],
            wordCount: 0
        }
    }

    // Default first chapter
    newChapter(title)

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!

        if (inCodeBlock) {
            if (line.trim().startsWith("```")) {
                inCodeBlock = false
                pList.push({ type: "code", text: codeContent.join("\n"), language: codeLanguage })
                codeContent = []
            } else {
                codeContent.push(line)
            }
            continue
        }

        if (line.trim().startsWith("```")) {
            inCodeBlock = true
            codeLanguage = line.trim().slice(3).trim()
            continue
        }

        if (line.trim().match(/^#+\s/)) {
            const level = line.match(/^(#+)/)![0].length
            const text = line.replace(/^#+\s/, "").trim()
            if (level <= 2 && pList.length > 0) {
                newChapter(text)
            } else {
                pList.push({ type: "heading", level, text })
            }
            continue
        }

        if (line.trim().startsWith(">")) {
            pList.push({ type: "quote", text: line.replace(/^>\s*/, "").trim() })
            continue
        }

        if (line.trim() === "---" || line.trim() === "***") {
            pList.push({ type: "separator", text: "" })
            continue
        }

        const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/)
        if (listMatch) {
            const indentStr = listMatch[1] || ""
            const bullet = listMatch[2] || ""
            const text = listMatch[3] || ""
            const ordered = /^\d/.test(bullet)
            const indent = Math.floor(indentStr.length / 2)
            pList.push({ type: "list-item", text, ordered, indent })
            continue
        }

        if (line.trim() !== "") {
            // Check for blockquotes inside normal text (like "> note")
            if (line.trim().startsWith(">!")) {
                 pList.push({ type: "note", text: line.replace(/^>!\s*/, "").trim(), noteKind: "note" })
            } else {
                // If previous was text, we could append, but let's keep them as separate paragraphs for now
                pList.push({ type: "paragraph", text: line.trim() })
            }
        }
    }

    if (inCodeBlock) {
         pList.push({ type: "code", text: codeContent.join("\n"), language: codeLanguage })
    }

    pushChapter()

    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)
    return { metadata, chapters, totalWords }
}
