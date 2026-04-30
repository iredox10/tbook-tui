// ─────────────────────────────────────────────────────────────
// PDF Parser — max-fidelity extraction for programming books
// Primary: pdftotext -bbox-layout (word/line coordinates)
// Fallback: pdftotext -layout
// ─────────────────────────────────────────────────────────────

import { execFileSync } from "child_process"
import { parse as parseHTML } from "node-html-parser"
import { detectLanguageFromContent } from "../utils/syntax-highlight"
import type { StyledParagraph } from "../utils/html-to-text"
import type { BookMetadata, Chapter, ParsedBook } from "./epub-parser"

interface PdfInfo {
    title?: string
    author?: string
    pages: number
}

interface BboxWord {
    xMin: number
    xMax: number
    yMin: number
    yMax: number
    text: string
}

interface BboxLine {
    page: number
    pageWidth: number
    pageHeight: number
    xMin: number
    xMax: number
    yMin: number
    yMax: number
    raw: string
    compact: string
    words: BboxWord[]
}

interface PdfMetrics {
    bodyLineHeight: number
    bodyLeft: number
    pageWidth: number
}

function hasCommand(command: string): boolean {
    try {
        execFileSync("which", [command], { stdio: ["ignore", "pipe", "pipe"] })
        return true
    } catch {
        return false
    }
}

function run(command: string, args: string[], maxBuffer: number = 64 * 1024 * 1024): string {
    return execFileSync(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        maxBuffer,
    })
}

/**
 * PDF support exists when pdftotext is available.
 */
export function hasPdfSupport(): boolean {
    return hasCommand("pdftotext")
}

function readPdfInfoField(info: string, key: string): string | undefined {
    const match = info.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))
    const value = match?.[1]?.trim()
    return value ? value : undefined
}

function getPdfInfo(filePath: string): PdfInfo {
    try {
        const info = run("pdfinfo", [filePath], 8 * 1024 * 1024)
        const pages = parseInt(readPdfInfoField(info, "Pages") || "0", 10)
        return {
            title: readPdfInfoField(info, "Title"),
            author: readPdfInfoField(info, "Author"),
            pages: Number.isFinite(pages) ? pages : 0,
        }
    } catch {
        return { pages: 0 }
    }
}

function extractBboxLayout(filePath: string): string {
    return run(
        "pdftotext",
        ["-bbox-layout", "-enc", "UTF-8", filePath, "-"],
        256 * 1024 * 1024,
    )
}

function extractLayoutText(filePath: string): string {
    return run(
        "pdftotext",
        ["-layout", "-enc", "UTF-8", filePath, "-"],
        64 * 1024 * 1024,
    )
}

function parseNum(value: string | undefined, fallback = 0): number {
    const n = parseFloat(value || "")
    return Number.isFinite(n) ? n : fallback
}

function normalizeWordText(text: string): string {
    return text
        .replace(/\u00a0/g, " ")
        .replace(/[\t\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function composeLineText(words: BboxWord[]): { raw: string; compact: string } {
    if (words.length === 0) {
        return { raw: "", compact: "" }
    }

    const sorted = words.slice().sort((a, b) => a.xMin - b.xMin)
    let raw = ""
    let prev: BboxWord | null = null

    for (const w of sorted) {
        if (prev) {
            const prevWidth = Math.max(1, prev.xMax - prev.xMin)
            const prevChar = Math.max(3, prevWidth / Math.max(1, prev.text.length))
            const gap = w.xMin - prev.xMax

            if (gap > prevChar * 3.2) raw += "   "
            else if (gap > prevChar * 1.8) raw += "  "
            else raw += " "
        }
        raw += w.text
        prev = w
    }

    raw = raw.replace(/\s+$/g, "")
    return {
        raw,
        compact: raw.replace(/\s+/g, " ").trim(),
    }
}

function parseBboxLines(html: string): BboxLine[] {
    const root = parseHTML(html, {
        lowerCaseTagName: true,
        blockTextElements: {
            script: false,
            style: false,
            pre: true,
        },
    })

    const lines: BboxLine[] = []
    const pageNodes = root.querySelectorAll("page")
    for (let pageIdx = 0; pageIdx < pageNodes.length; pageIdx++) {
        const pageNode = pageNodes[pageIdx]!
        const pageNumber = pageIdx + 1
        const pageWidth = parseNum(pageNode.getAttribute("width"), 612)
        const pageHeight = parseNum(pageNode.getAttribute("height"), 792)

        const lineNodes = pageNode.querySelectorAll("line")
        for (const lineNode of lineNodes) {
            const words: BboxWord[] = []
            for (const wordNode of lineNode.querySelectorAll("word")) {
                const text = normalizeWordText(wordNode.textContent || "")
                if (!text) continue
                words.push({
                    xMin: parseNum(wordNode.getAttribute("xMin")),
                    xMax: parseNum(wordNode.getAttribute("xMax")),
                    yMin: parseNum(wordNode.getAttribute("yMin")),
                    yMax: parseNum(wordNode.getAttribute("yMax")),
                    text,
                })
            }

            const composed = composeLineText(words)
            if (!composed.compact) continue

            const xMin = parseNum(
                lineNode.getAttribute("xMin"),
                words.length > 0 ? Math.min(...words.map(w => w.xMin)) : 0,
            )
            const xMax = parseNum(
                lineNode.getAttribute("xMax"),
                words.length > 0 ? Math.max(...words.map(w => w.xMax)) : 0,
            )
            const yMin = parseNum(
                lineNode.getAttribute("yMin"),
                words.length > 0 ? Math.min(...words.map(w => w.yMin)) : 0,
            )
            const yMax = parseNum(
                lineNode.getAttribute("yMax"),
                words.length > 0 ? Math.max(...words.map(w => w.yMax)) : 0,
            )

            lines.push({
                page: pageNumber,
                pageWidth,
                pageHeight,
                xMin,
                xMax,
                yMin,
                yMax,
                raw: composed.raw,
                compact: composed.compact,
                words,
            })
        }
    }

    return lines.sort((a, b) => a.page - b.page || a.yMin - b.yMin || a.xMin - b.xMin)
}

function dropFrontMatterPages(lines: BboxLine[]): BboxLine[] {
    if (lines.length === 0) return lines

    const byPage = new Map<number, BboxLine[]>()
    for (const line of lines) {
        const list = byPage.get(line.page) || []
        list.push(line)
        byPage.set(line.page, list)
    }

    const pages = Array.from(byPage.keys()).sort((a, b) => a - b)
    if (pages.length === 0) return lines

    let startPage = pages[0]!
    const scanLimit = Math.min(8, pages.length)

    for (let i = 0; i < scanLimit; i++) {
        const pageNo = pages[i]!
        const pageLines = byPage.get(pageNo) || []
        const joined = pageLines.map(l => l.compact).join(" \n ")

        const hasToc = /table of contents/i.test(joined)
        const hasApiSection = /\b\d+\.\d+\s+[A-Z]/.test(joined)
        const hasNumericLeaders = (joined.match(/\.{4,}\s*(?:\d+|[ivxlcdm]+)/ig) || []).length >= 5

        if (hasToc || (hasApiSection && hasNumericLeaders)) {
            startPage = pageNo + 1
            continue
        }

        if (/^\d+\s+[A-Z][^\n]{3,}$/.test((pageLines[0]?.compact || "").trim())) {
            startPage = pageNo
            break
        }

        if (i > 0) {
            break
        }
    }

    const filtered = lines.filter(line => line.page >= startPage)
    return filtered.length > 0 ? filtered : lines
}

function cleanPdfInfoValue(value: string | undefined): string | undefined {
    if (!value) return undefined
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (/^(unknown|anonymous|untitled)$/i.test(trimmed)) return undefined
    if (/^creator:\s*/i.test(trimmed)) return undefined
    if (/^subject:\s*$/i.test(trimmed)) return undefined
    if (/^title:\s*$/i.test(trimmed)) return undefined
    return trimmed
}

function normalizeHeaderFooterKey(text: string): string {
    return text
        .toLowerCase()
        .replace(/\bpage\s+\d+\b/g, "page #")
        .replace(/\d+/g, "#")
        .replace(/\s+/g, " ")
        .trim()
}

function isMarginLine(line: BboxLine): boolean {
    const topRatio = line.yMin / Math.max(1, line.pageHeight)
    const bottomRatio = line.yMax / Math.max(1, line.pageHeight)
    return topRatio < 0.1 || bottomRatio > 0.9
}

function filterRepeatedMarginLines(lines: BboxLine[]): BboxLine[] {
    const counts = new Map<string, number>()
    for (const line of lines) {
        if (!isMarginLine(line)) continue
        const key = normalizeHeaderFooterKey(line.compact)
        if (!key || key.length < 3 || key.length > 120) continue
        counts.set(key, (counts.get(key) || 0) + 1)
    }

    return lines.filter(line => {
        const text = line.compact
        if (!text) return false

        if (isMarginLine(line)) {
            if (/^\d+$/.test(text)) return false
            const key = normalizeHeaderFooterKey(text)
            if ((counts.get(key) || 0) >= 3) return false
        }

        return true
    })
}

function median(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1]! + sorted[mid]!) / 2
    }
    return sorted[mid]!
}

function computeMetrics(lines: BboxLine[]): PdfMetrics {
    const bodyCandidates = lines.filter(line => {
        const text = line.compact
        if (text.length < 28) return false
        if (isMarginLine(line)) return false
        if (/^\d+$/.test(text)) return false
        return true
    })

    const heights = bodyCandidates
        .map(line => Math.max(1, line.yMax - line.yMin))
        .filter(h => h > 1)
    const bodyLineHeight = median(heights) || 12

    const lefts = bodyCandidates
        .map(line => line.xMin)
        .filter(v => Number.isFinite(v))
    const bodyLeft = median(lefts) || Math.min(...lines.map(line => line.xMin)) || 72

    const widths = lines.map(line => line.pageWidth).filter(v => v > 0)
    const pageWidth = median(widths) || 612

    return { bodyLineHeight, bodyLeft, pageWidth }
}

function symbolDensity(text: string): number {
    const symbols = (text.match(/[{}()[\];:=<>+\-*/%$#@`|]/g) || []).length
    return symbols / Math.max(1, text.length)
}

function codeKeywordScore(text: string): number {
    let score = 0
    if (/\b(function|const|let|var|interface|namespace|export\s+default|import\s+.+\s+from|class\s+\w+\s*[{:]|class\s+\w+\s+extends)\b/.test(text)) score += 2
    if (/\b(def\s+\w+\s*\(|from\s+\w+\s+import|async\s+def|lambda\b|except\s+\w+|elif\s+.+:)\b/.test(text)) score += 2
    if (/\b(fn\s+\w+\s*\(|impl\s+\w+|struct\s+\w+|enum\s+\w+|trait\s+\w+|pub\s+fn|use\s+\w+::|match\s+\w+)\b/.test(text)) score += 2
    if (/\b(func\s+\w+\s*\(|package\s+\w+|go\s+func|defer\s+\w+|type\s+\w+\s+struct|interface\s*\{)\b/.test(text)) score += 2
    if (/\bSELECT\b.+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bCREATE\s+(TABLE|INDEX|VIEW)\b|\bALTER\s+TABLE\b/i.test(text)) score += 2
    if (/\b(typedef|struct|enum|union|template|#include|using\s+namespace)\b/.test(text)) score += 2
    if (/=>|->|::|\{\}|\(\)|;\s*$/.test(text)) score += 1
    if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*\{?$/.test(text)) score += 1
    return score
}

function looksLikeCodeLine(line: BboxLine, metrics: PdfMetrics): boolean {
    const text = line.compact
    if (!text) return false
    if (looksLikeTocLine(line)) return false

    const keywords = codeKeywordScore(text)
    if (text.length > 220 && symbolDensity(text) < 0.05 && keywords === 0) return false
    if (text.length > 120 && symbolDensity(text) < 0.06 && keywords === 0) return false
    if (/\bhttps?:\/\/\S+/i.test(text) && keywords === 0) return false
    if (/^[A-Z][A-Za-z0-9 ,.'"-]{6,}$/.test(text) && keywords === 0) return false
    
    // Reject garbage text from failed PDF font extraction (e.g. Arabic turning into ~ ~ I , , L)
    if (keywords === 0 && (/[~]{2,}/.test(text) || /(~\s*){2,}/.test(text) || /(,\s*){3,}/.test(text))) {
        return false
    }

    const indent = line.xMin - metrics.bodyLeft
    const density = symbolDensity(text)
    const punctuation = /[{}()[\];=<>]/.test(text)
    const lineHeight = Math.max(1, line.yMax - line.yMin)

    if (/^(\$ |>>> |\.{3} |In \[\d+\]:|Out\[\d+\]:)/.test(text)) return true
    if (/^#(include|define|ifdef|ifndef|endif|if|else|elif)\b/.test(text)) return true
    if (/^(\/\/|#\s|\/\*|\*\s)/.test(text)) return true
    if (/^[{}()[\];,]+$/.test(text)) return true
    if (/^(typedef|struct|enum|union|class|interface|template)\b/.test(text)) return true
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*\s+)+main\s*\(/.test(text)) return true
    if (/^(?:void|int|char|float|double|long|short|unsigned|signed|size_t|ssize_t)\s*$/.test(text)) return true
    if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*;?$/.test(text) && punctuation) return true

    if (keywords >= 2 && (indent > metrics.bodyLineHeight * 0.45 || punctuation || density > 0.06)) return true
    if (indent > metrics.bodyLineHeight * 1.4 && ((keywords >= 1 && punctuation) || density > 0.14) && text.length < 120) return true
    if (density > 0.18 && text.split(/\s+/).length <= 16 && punctuation) return true
    if (lineHeight < metrics.bodyLineHeight * 0.92 && density > 0.1 && punctuation) return true
    if (/;\s*$/.test(text) && (keywords > 0 || punctuation)) return true
    if (keywords === 1 && text.length < 64 && punctuation && density > 0.08) return true
    if (keywords >= 1 && punctuation && text.length < 100 && density > 0.06) return true

    return false
}

function isTocEntry(text: string): boolean {
    return /^\d+(?:\.\d+)*\.?\s+.+\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i.test(text)
}

function looksLikeTocLine(line: BboxLine): boolean {
    const text = line.compact
    if (!text) return false
    if (isTocEntry(text)) return true
    if (/^\d+\s+\d+(?:\.\d+)*\.?\s+[A-Za-z]/.test(text)) return true
    if (/^\d+(?:\.\d+)*\.?\s+.+\.{4,}\s*[ivxlcdm]+$/i.test(text)) return true
    if (/^\.{8,}$/.test(text)) return true
    return /^table of contents$/i.test(text)
}

function shouldTreatAsHeading(line: BboxLine, metrics: PdfMetrics): { isHeading: boolean; level: number } {
    if (looksLikeTocLine(line)) return { isHeading: false, level: 0 }
    return headingFromLine(line, metrics)
}

function headingFromLine(line: BboxLine, metrics: PdfMetrics): { isHeading: boolean; level: number } {
    const text = line.compact
    if (!text || text.length > 140) return { isHeading: false, level: 0 }
    if (/^\.{8,}$/.test(text)) return { isHeading: false, level: 0 }
    if ((text.match(/\./g) || []).length >= 8 && text.replace(/[.\s]/g, "").length < 25) {
        return { isHeading: false, level: 0 }
    }
    
    // Reject garbage text (bad font extraction)
    if (/[~^]{2,}/.test(text) || /(,\s*){3,}/.test(text) || symbolDensity(text) > 0.3) {
        return { isHeading: false, level: 0 }
    }
    if (
        text.split(/\s+/).length >= 7 &&
        /[a-z]/.test(text) &&
        /[,;:]/.test(text) &&
        !/^(chapter|part|appendix|section)\b/i.test(text) &&
        !/^\d+(?:\.\d+)*\s+/.test(text)
    ) {
        return { isHeading: false, level: 0 }
    }
    if (
        text.length > 55 &&
        /[a-z]/.test(text) &&
        !/^(chapter|part|appendix|section)\b/i.test(text) &&
        !/^\d+(?:\.\d+)*\s+/.test(text)
    ) {
        return { isHeading: false, level: 0 }
    }

    if (/^(chapter|part|appendix)\s+\w+/i.test(text)) return { isHeading: true, level: 1 }
    if (/^section\s+\d+/i.test(text)) return { isHeading: true, level: 2 }
    if (/^\d+\.\s+[A-Z]/.test(text)) return { isHeading: true, level: 2 }
    if (/^\d+\.\d+\s+[A-Z]/.test(text)) return { isHeading: true, level: 3 }

    if (/^[a-z]/.test(text) && !/^\d/.test(text)) return { isHeading: false, level: 0 }
    if (/^[A-Z].+\.$/.test(text) && !/^\d/.test(text)) return { isHeading: false, level: 0 }

    const h = Math.max(1, line.yMax - line.yMin)
    const ratio = h / Math.max(1, metrics.bodyLineHeight)
    if (ratio >= 1.9) return { isHeading: true, level: 1 }
    if (ratio >= 1.45) return { isHeading: true, level: 2 }
    if (ratio >= 1.24 && text.length <= 100) return { isHeading: true, level: 3 }

    const width = line.xMax - line.xMin
    const centered = line.xMin > metrics.bodyLeft + metrics.bodyLineHeight && width < metrics.pageWidth * 0.72
    if (centered && text.length <= 90 && text.length >= 4) {
        return { isHeading: true, level: 2 }
    }

    if (text === text.toUpperCase() && text.length <= 60 && /[A-Z]{3,}/.test(text) && !/^\d/.test(text)) {
        return { isHeading: true, level: 2 }
    }

    return { isHeading: false, level: 0 }
}

function looksLikeListItem(text: string): { isList: boolean; ordered: boolean; indent: number; index?: number; body: string } {
    const bullet = text.match(/^\s*([-*+•●◦▪▸])\s+(.+)$/)
    if (bullet) {
        return {
            isList: true,
            ordered: false,
            indent: 0,
            body: bullet[2]!,
        }
    }

    const ordered = text.match(/^\s*(\d+)[.)]\s+(.+)$/)
    if (ordered) {
        return {
            isList: true,
            ordered: true,
            indent: 0,
            index: parseInt(ordered[1]!, 10),
            body: ordered[2]!,
        }
    }

    return { isList: false, ordered: false, indent: 0, body: "" }
}

function parseListItem(line: BboxLine, metrics: PdfMetrics): { isList: boolean; ordered: boolean; indent: number; index?: number; body: string } {
    const parsed = looksLikeListItem(line.raw)
    if (!parsed.isList) return parsed

    const relativeIndent = Math.max(0, line.xMin - metrics.bodyLeft)
    const indent = Math.max(0, Math.round(relativeIndent / Math.max(8, metrics.bodyLineHeight * 1.2)))
    return { ...parsed, indent }
}

function detectNoteFromText(text: string): { kind: StyledParagraph["noteKind"]; body: string } | null {
    const match = text.match(/^(note|tip|warning|important|caution|remember)[:.\-]\s+(.+)$/i)
    if (!match) return null

    const label = match[1]!.toLowerCase()
    const body = match[2]!.trim()
    if (!body) return null

    if (label === "tip") return { kind: "tip", body }
    if (label === "warning" || label === "caution") return { kind: "warning", body }
    if (label === "important" || label === "remember") return { kind: "important", body }
    return { kind: "note", body }
}

function normalizeSpacedCaps(text: string): string {
    let normalized = text.replace(/\s+([:;,.)\]])/g, "$1").replace(/([(\[])\s+/g, "$1").trim()

    for (let i = 0; i < 4; i++) {
        const next = normalized.replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, "$1$2")
        if (next === normalized) break
        normalized = next
    }

    return normalized.replace(/\s+/g, " ").trim()
}

function trimInlineHeadingBody(text: string): string {
    const match = text.match(/^(\d+(?:\.\d+)+|\d+\.)\s+(.+)$/)
    if (!match) return text

    const prefix = match[1]!
    const rest = match[2]!.trim()
    const phraseStarter = rest.match(/^(.+?)\s+(Of course|It turns out)\b.*$/)
    if (phraseStarter) {
        const candidate = `${prefix} ${phraseStarter[1]!.trim()}`
        if (candidate.split(/\s+/).length <= 10) return candidate
    }

    const sentenceStarters = "The|This|These|That|Those|Our|We|Now|To|For|In|On|At|As|After|Before|Because|However|Unfortunately|Fortunately|Though|Although|But|And|Or|If|When|While|Since|Instead|Specifically|Interestingly|Underlying|Finally|First|Second|Third"
    const inlineStarter = rest.match(new RegExp(`^(.+?)\\s+(${sentenceStarters})\\s+[a-z].*$`))
    if (inlineStarter) {
        const candidate = `${prefix} ${inlineStarter[1]!.trim()}`
        if (candidate.split(/\s+/).length <= 10) return candidate
    }

    const tokens = rest.split(/\s+/)
    const stopTokens = new Set([
        "Figure", "Table", "Example", "Exercise", "Now", "Thus", "However", "Unfortunately",
        "Fortunately", "Specifically", "Instead", "Remember", "To", "This", "These", "That",
        "Those", "Our", "We", "In", "On", "At", "As", "After", "Before", "Because", "When",
        "While", "Though", "Although", "But", "And", "Or", "If", "Since", "Interestingly",
        "Underlying", "Finally", "First", "Second", "Third",
    ])

    const kept: string[] = []
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!
        const plain = token.replace(/[“”"'`,.;:!?()[\]{}]+/g, "")
        const next = tokens[i + 1]?.replace(/[“”"'`,.;:!?()[\]{}]+/g, "") || ""

        if (
            kept.length >= 1 &&
            stopTokens.has(plain) &&
            (!next || /^[a-z]/.test(next) || /^\d/.test(next) || plain === "Figure" || plain === "Table")
        ) {
            break
        }

        kept.push(token)

        if (kept.length >= 10 && /[.?!:]$/.test(token)) {
            break
        }
    }

    const candidate = `${prefix} ${kept.join(" ")}`.replace(/\s+/g, " ").trim()
    return candidate.length >= prefix.length + 4 ? candidate : text
}

function sanitizeHeadingText(text: string): string {
    return trimInlineHeadingBody(normalizeSpacedCaps(text))
}

function looksLikeSourceLineNumber(line: BboxLine, metrics: PdfMetrics): boolean {
    const text = line.compact.trim()
    if (!/^\d{1,3}$/.test(text)) return false
    if (isMarginLine(line)) return false
    if (line.xMax > metrics.bodyLeft - Math.max(4, metrics.bodyLineHeight * 0.25)) return false
    return true
}

function filterInlineArtifacts(lines: BboxLine[], metrics: PdfMetrics): BboxLine[] {
    return lines.filter(line => {
        if (looksLikeSourceLineNumber(line, metrics)) return false
        if (/^Figure \d+(?:\.\d+)*:/i.test(line.compact)) return false
        return true
    })
}

function filterInsetAsideBlocks(lines: BboxLine[], metrics: PdfMetrics): BboxLine[] {
    const filtered: BboxLine[] = []
    let skippingAside = false
    let asidePage = 0
    let asideLastYMax = 0

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const next = lines[i + 1] || null

        if (skippingAside) {
            if (line.page !== asidePage || line.yMin - asideLastYMax > metrics.bodyLineHeight * 2.4) {
                skippingAside = false
            } else {
                asideLastYMax = Math.max(asideLastYMax, line.yMax)
                continue
            }
        }

        if (/^A\s+SIDE\b|^ASIDE\b/i.test(line.compact)) {
            skippingAside = true
            asidePage = line.page
            asideLastYMax = line.yMax
            continue
        }

        if (
            next &&
            line.page === next.page &&
            /^\d{1,2}$/.test(line.compact.trim()) &&
            line.xMin >= metrics.bodyLeft + metrics.bodyLineHeight * 0.4 &&
            line.xMin <= metrics.bodyLeft + metrics.bodyLineHeight * 2.2 &&
            next.yMin - line.yMax <= metrics.bodyLineHeight * 0.9 &&
            next.xMin >= line.xMin &&
            next.compact.length > 40
        ) {
            skippingAside = true
            asidePage = line.page
            asideLastYMax = next.yMax
            continue
        }

        filtered.push(line)
    }

    return filtered
}

function mergeWrappedCodeDeclarations(lines: BboxLine[]): BboxLine[] {
    const merged: BboxLine[] = []

    for (const line of lines) {
        const prev = merged[merged.length - 1]
        if (
            prev &&
            prev.page === line.page &&
            Math.abs(prev.yMin - line.yMin) <= 1.5 &&
            /^(\/\/|\/\*|\*)/.test(line.compact) &&
            line.xMin > prev.xMax
        ) {
            prev.raw = `${prev.raw} ${line.raw.trim()}`
            prev.compact = `${prev.compact} ${line.compact}`.replace(/\s+/g, " ").trim()
            prev.xMax = Math.max(prev.xMax, line.xMax)
            prev.yMax = Math.max(prev.yMax, line.yMax)
            prev.words.push(...line.words)
            continue
        }

        if (
            prev &&
            prev.page === line.page &&
            line.yMin - prev.yMax <= 1.6 &&
            Math.abs(prev.xMin - line.xMin) <= 4 &&
            /^(?:[A-Za-z_][A-Za-z0-9_]*\s*[*&]?\s*)$/.test(prev.compact) &&
            /^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line.compact)
        ) {
            prev.raw = `${prev.raw.trimEnd()} ${line.raw.trimStart()}`
            prev.compact = `${prev.compact} ${line.compact}`.replace(/\s+/g, " ").trim()
            prev.xMax = Math.max(prev.xMax, line.xMax)
            prev.yMax = Math.max(prev.yMax, line.yMax)
            prev.words.push(...line.words)
            continue
        }

        merged.push({ ...line, words: line.words.slice() })
    }

    return merged
}

function looksLikeTableLine(line: BboxLine): boolean {
    const text = line.compact
    if (!text) return false

    if (/^(table of contents)$/i.test(text)) return false
    if (isTocEntry(text)) return false

    if ((text.match(/\|/g) || []).length >= 2) return true
    if (/\.{4,}\s*\d+$/.test(text)) return true

    const cols = line.raw.trim().split(/\s{2,}/).filter(Boolean)
    if (cols.length >= 3) return true

    return false
}

function parseTableRows(lines: BboxLine[]): string[][] {
    const rows: string[][] = []

    for (const line of lines) {
        const text = line.raw.trim()
        if (!text) continue

        const tocMatch = text.match(/^(.*?)\s*\.{4,}\s*(\d+)\s*$/)
        if (tocMatch) {
            rows.push([tocMatch[1]!.trim(), tocMatch[2]!])
            continue
        }

        if ((text.match(/\|/g) || []).length >= 2) {
            const cells = text.split("|").map(c => c.trim()).filter(Boolean)
            if (cells.length >= 2) rows.push(cells)
            continue
        }

        const cols = text.split(/\s{2,}/).map(c => c.trim()).filter(Boolean)
        if (cols.length >= 2) rows.push(cols)
    }

    return rows
}

function shouldStartNewCodeBlock(text: string, metrics: PdfMetrics, xMin: number): boolean {
    const indent = xMin - metrics.bodyLeft
    if (/\bhttps?:\/\/\S+/i.test(text) && codeKeywordScore(text) === 0) return false
    if (/^[A-Z][A-Za-z0-9 ,.'"-]{6,}$/.test(text) && codeKeywordScore(text) === 0) return false
    if (text.length > 100 && symbolDensity(text) < 0.08 && codeKeywordScore(text) < 2) return false
    if (indent > metrics.bodyLineHeight * 0.6) return true
    if (codeKeywordScore(text) >= 2) return true
    if (/^(\$ |>>> |\.{3} |In \[\d+\]:|Out\[\d+\]:)/.test(text)) return true
    if (/^#(include|define|ifdef|ifndef|endif|if|else|elif)\b/.test(text)) return true
    if (/^\s*(if|for|while|switch|class|def|fn|func|import|from|return)\b/.test(text)) return true
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*\s+)+main\s*\(/.test(text)) return true
    if (/^(?:void|int|char|float|double|long|short|unsigned|signed|size_t|ssize_t)\s*$/.test(text)) return true
    if (/^(\/\/|#\s|\/\*|\*\s)/.test(text)) return true
    if (/^[{}()[\];,]+$/.test(text)) return true
    if (/^(typedef|struct|enum|union|class|interface|template)\b/.test(text)) return true
    return false
}

function shouldContinueCodeBlock(text: string, line: BboxLine, prev: BboxLine | null, metrics: PdfMetrics): boolean {
    if (!prev) return false

    const verticalGap = line.yMin - prev.yMax
    if (verticalGap > metrics.bodyLineHeight * 1.15) return false

    const indent = line.xMin - metrics.bodyLeft
    if (indent > metrics.bodyLineHeight * 0.45) return true
    if (/^#(include|define|ifdef|ifndef|endif|if|else|elif)\b/.test(text)) return true
    if (codeKeywordScore(text) > 0) return true
    if (symbolDensity(text) > 0.12 && text.length < 90) return true
    if (symbolDensity(text) > 0.08 && text.length < 60) return true
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*\s+)+main\s*\(/.test(text)) return true
    if (/^(?:void|int|char|float|double|long|short|unsigned|signed|size_t|ssize_t)\s*$/.test(text)) return true
    if (/^(else\b|elif\b|except\b|catch\b|finally\b|case\b|default\b)/.test(text)) return true
    if (/^(\}|\)|\]|\};?)$/.test(text.trim())) return true

    return false
}

function normalizeCodeIndent(text: string, xMin: number, metrics: PdfMetrics): string {
    const level = Math.max(0, Math.min(24, Math.round((xMin - metrics.bodyLeft) / Math.max(6, metrics.bodyLineHeight * 0.5))))
    return `${" ".repeat(level * 2)}${text.replace(/\s+$/g, "").trimStart()}`
}

function joinProseLines(lines: string[]): string {
    let out = ""
    for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue

        if (!out) {
            out = line
            continue
        }

        if (out.endsWith("-") && /^[a-z]/.test(line)) {
            out = out.slice(0, -1) + line
            continue
        }

        out += " " + line
    }

    return out.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim()
}

function linesToStyledParagraphs(lines: BboxLine[]): StyledParagraph[] {
    if (lines.length === 0) return []

    const baseMetrics = computeMetrics(lines)
    const preparedLines = mergeWrappedCodeDeclarations(
        filterInsetAsideBlocks(filterInlineArtifacts(lines, baseMetrics), baseMetrics),
    )
    const metrics = computeMetrics(preparedLines)
    const paragraphs: StyledParagraph[] = []

    let proseBuffer: string[] = []
    let codeBuffer: { rawText: string; xMin: number }[] = []
    let tableBuffer: BboxLine[] = []
    let prev: BboxLine | null = null

    const flushProse = () => {
        if (proseBuffer.length === 0) return
        const text = joinProseLines(proseBuffer)
        proseBuffer = []
        if (text) paragraphs.push({ type: "paragraph", text })
    }

    const flushCode = () => {
        if (codeBuffer.length === 0) return

        const prepared = codeBuffer
            .map(line => line.rawText === ""
                ? ""
                : normalizeCodeIndent(line.rawText, line.xMin, metrics))

        while (prepared.length > 0 && !prepared[0]!.trim()) prepared.shift()
        while (prepared.length > 0 && !prepared[prepared.length - 1]!.trim()) prepared.pop()

        if (prepared.length > 0) {
            const nonEmpty = prepared.filter(line => line.trim().length > 0)
            const minIndent = nonEmpty.length > 0
                ? nonEmpty.reduce((min, line) => Math.min(min, line.length - line.trimStart().length), 999)
                : 0
            const normalized = prepared
                .map(line => line.slice(Math.min(minIndent, line.length - line.trimStart().length)))
                .join("\n")

            paragraphs.push({
                type: "code",
                text: normalized,
                language: detectLanguageFromContent(normalized),
            })
        }

        codeBuffer = []
    }

    const flushTable = () => {
        if (tableBuffer.length === 0) return
        const rows = parseTableRows(tableBuffer)
        if (rows.length >= 2) {
            paragraphs.push({
                type: "table",
                text: rows.map(r => r.join(" | ")).join("\n"),
                tableRows: rows,
            })
        } else {
            for (const line of tableBuffer) {
                if (line.compact) paragraphs.push({ type: "paragraph", text: line.compact })
            }
        }
        tableBuffer = []
    }

    const flushAll = () => {
        flushProse()
        flushCode()
        flushTable()
    }

    const appendToLastListItem = (text: string) => {
        const last = paragraphs[paragraphs.length - 1]
        if (!last || last.type !== "list-item") return false
        last.text = `${last.text} ${text}`.replace(/\s+/g, " ").trim()
        return true
    }

    for (const line of preparedLines) {
        const text = line.compact
        if (!text) continue

        const pageChanged = !!prev && line.page !== prev.page
        const verticalGap = !prev || pageChanged
            ? Number.POSITIVE_INFINITY
            : line.yMin - prev.yMax

        if (pageChanged || verticalGap > metrics.bodyLineHeight * 1.9) {
            flushAll()
        }

        const heading = shouldTreatAsHeading(line, metrics)
        if (heading.isHeading && !looksLikeCodeLine(line, metrics) && !looksLikeTableLine(line)) {
            flushAll()
            paragraphs.push({ type: "heading", text: sanitizeHeadingText(text), level: heading.level })
            prev = line
            continue
        }

        if (/^[-=*_]{3,}\s*$/.test(text)) {
            flushAll()
            paragraphs.push({ type: "separator", text: "" })
            prev = line
            continue
        }

        if (looksLikeCodeLine(line, metrics)) {
            flushProse()
            flushTable()
            if (shouldStartNewCodeBlock(text, metrics, line.xMin) || codeBuffer.length > 0) {
                codeBuffer.push({ rawText: line.raw, xMin: line.xMin })
                prev = line
                continue
            }

            proseBuffer.push(text)
            prev = line
            continue
        }

        if (codeBuffer.length > 0) {
            const continuation = shouldContinueCodeBlock(text, line, prev, metrics)
            if (continuation) {
                if (prev) {
                    const gap = line.yMin - prev.yMax
                    if (gap > metrics.bodyLineHeight * 1.35 && gap <= metrics.bodyLineHeight * 2.8) {
                        codeBuffer.push({ rawText: "", xMin: line.xMin })
                    }
                }
                codeBuffer.push({ rawText: line.raw, xMin: line.xMin })
                prev = line
                continue
            }
            flushCode()
        }

        if (looksLikeTableLine(line)) {
            flushProse()
            tableBuffer.push(line)
            prev = line
            continue
        }

        if (tableBuffer.length > 0) {
            const continuation = verticalGap <= metrics.bodyLineHeight * 1.2 && looksLikeTableLine(line)
            if (!continuation) flushTable()
        }

        const note = detectNoteFromText(text)
        if (note) {
            flushAll()
            paragraphs.push({ type: "note", text: note.body, noteKind: note.kind })
            prev = line
            continue
        }

        const list = parseListItem(line, metrics)
        if (list.isList) {
            flushProse()
            paragraphs.push({
                type: "list-item",
                text: list.body,
                ordered: list.ordered,
                indent: list.indent,
                index: list.index,
            })
            prev = line
            continue
        }

        if (
            proseBuffer.length === 0 &&
            paragraphs.length > 0 &&
            prev &&
            verticalGap <= metrics.bodyLineHeight * 1.2 &&
            line.xMin > prev.xMin + metrics.bodyLineHeight * 0.45 &&
            !looksLikeTableLine(line) &&
            !looksLikeCodeLine(line, metrics)
        ) {
            if (appendToLastListItem(text)) {
                prev = line
                continue
            }
        }

        if (verticalGap > metrics.bodyLineHeight * 1.35) {
            flushProse()
        }

        proseBuffer.push(text)
        prev = line
    }

    flushAll()

    return paragraphs.filter(p => (p.text || "").trim().length > 0 || p.type === "separator")
}

function isLikelyTocParagraph(text: string): boolean {
    if (!text) return false
    if (/^table of contents/i.test(text)) return true
    if (/\.{4,}/.test(text)) return true
    if (/^\d+(?:\.\d+)*\s+[A-Za-z]/.test(text)) return true
    return false
}

function looksLikeTocishText(text: string): boolean {
    const normalized = sanitizeHeadingText(text)
    if (!normalized) return false
    if (/^table of contents$/i.test(normalized)) return true
    if (/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i.test(normalized)) return true
    if (/(references|homework|general index|asides|tips|cruces).*\b\d{1,4}\b/i.test(normalized)) return true
    if (/^\d+(?:\.\d+)*\s+.+\b\d{1,4}\b$/.test(normalized) && normalized.length <= 140) return true
    return false
}

function countWords(paragraphs: StyledParagraph[]): number {
    return paragraphs.reduce((sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length, 0)
}

function makeChapter(order: number, title: string, paragraphs: StyledParagraph[]): Chapter {
    return {
        id: `ch-${order}`,
        title: title.trim() || `Chapter ${order + 1}`,
        order,
        paragraphs,
        wordCount: countWords(paragraphs),
    }
}

function looksLikeBibliographyHeading(text: string): boolean {
    if (/^[A-Z][A-Z' .&-]{2,}\s+\d{4}$/.test(text)) return true
    if (/^[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z'.-]+)?(?:,\s*)?\s+\d{4}$/.test(text)) return true
    if (/^(SOSP|OSDI|ASPLOS|SIGCOMM|MICRO|ISCA|NSDI|EuroSys|FAST|ATC)(?:\s|['’])/.test(text)) return true
    return false
}

function looksLikeDiagramHeading(text: string): boolean {
    text = normalizeSpacedCaps(text)
    if (!text) return false
    if (/^(chapter|part|appendix|section)\s+\w+/i.test(text)) return false
    if (/^\d+(?:\.\d+)+\s+[A-Z]/.test(text)) return false
    if (/^figure\b/i.test(text)) return true
    if (/^[.=0-9]/.test(text)) return true
    if (/^[A-Z]{1,4}$/.test(text)) return true
    if (/^\d+\s*(KB|MB|GB|TB|%|ms|us|ns)$/i.test(text)) return true
    if (/^[A-Z0-9 ]+$/.test(text) && text.length <= 6) return true
    if (/^[A-Z][a-z]+$/.test(text) && text.length <= 7) return true
    if (
        text.length <= 22 &&
        text.split(/\s+/).length <= 2 &&
        !/[.:?!]/.test(text) &&
        /^[A-Za-z0-9 ]+$/.test(text)
    ) {
        return true
    }
    return false
}

function headingPriority(text: string, level: number): number {
    text = sanitizeHeadingText(text)
    if (looksLikeBibliographyHeading(text) || looksLikeDiagramHeading(text)) return -1
    if (/^(chapter|part|appendix)\s+\w+/i.test(text)) return 100
    if (/^\d+(?:\.\d+)+\s+[A-Z]/.test(text)) return 95
    if (/^\d+\.\s+[A-Z]/.test(text)) return 90
    if (/^section\s+\d+/i.test(text)) return 85
    if (/\bCRUX\b/i.test(text) && /:\s+\S.+\S/.test(text)) return 88
    if (/\bCRUX\b/i.test(text)) return 25
    return Math.max(0, 40 - level * 4)
}

function chooseChapterTitle(paragraphs: StyledParagraph[], fallbackTitle: string): string {
    const headings = paragraphs
        .filter((p) => p.type === "heading")
        .map((p) => ({
            text: sanitizeHeadingText(p.text.trim()),
            level: p.level || 3,
        }))
        .filter((p) => !!p.text)

    const bestHeading = headings
        .map((heading) => ({
            ...heading,
            score: headingPriority(heading.text, heading.level),
        }))
        .filter((heading) => heading.score >= 0)
        .sort((a, b) => b.score - a.score)[0]

    if (bestHeading) {
        return bestHeading.text
    }

    const prose = paragraphs.find((p) => p.type === "paragraph" && p.text.trim().length > 20)
    if (prose) {
        const snippet = prose.text.trim().replace(/\s+/g, " ")
        return snippet.length > 48 ? `${snippet.slice(0, 45).trimEnd()}...` : snippet
    }

    return fallbackTitle
}

function mergeBrokenParagraphs(paragraphs: StyledParagraph[]): StyledParagraph[] {
    const merged: StyledParagraph[] = []

    for (const paragraph of paragraphs) {
        const currentText = (paragraph.text || "").trim()
        const prev = merged[merged.length - 1]

        if (
            prev &&
            prev.type === "paragraph" &&
            paragraph.type === "paragraph" &&
            currentText
        ) {
            const prevText = prev.text.trim()
            const startsLower = /^[a-z(]/.test(currentText)
            const prevHyphen = /[A-Za-z]-$/.test(prevText)
            const prevSoftEnd = /(?:,|;|:|of|to|the|a|an|and|or|for|with|into|onto|from|their|its)$/.test(prevText)

            if (prevHyphen) {
                prev.text = `${prevText.slice(0, -1)}${currentText}`.replace(/\s+/g, " ").trim()
                continue
            }

            if (startsLower || prevSoftEnd) {
                prev.text = `${prevText} ${currentText}`.replace(/\s+/g, " ").trim()
                continue
            }
        }

        merged.push({ ...paragraph })
    }

    return merged
}

function shouldSplitAtHeading(text: string, level: number, currentParagraphCount: number): boolean {
    text = sanitizeHeadingText(text)
    if (currentParagraphCount < 10) return false
    if (looksLikeDiagramHeading(text)) return false
    if (looksLikeBibliographyHeading(text)) return false
    if (/^(chapter|part|appendix)\s+\w+/i.test(text)) return true
    if (/\bCRUX\b/i.test(text) && currentParagraphCount >= 24) return true
    if (/^\d+(?:\.\d+)+\s+[A-Z]/.test(text) && currentParagraphCount >= 16) return true
    if (/^\d+\.\s+[A-Z]/.test(text) && currentParagraphCount >= 24) return true
    if (
        level <= 2 &&
        currentParagraphCount >= 60 &&
        text.split(/\s+/).length >= 3 &&
        text.length >= 18
    ) {
        return true
    }
    return false
}

function buildChaptersFromParagraphs(paragraphs: StyledParagraph[], fallbackTitle: string): Chapter[] {
    if (paragraphs.length === 0) return []

    const chapters: Chapter[] = []
    let currentTitle = fallbackTitle || "Full Document"
    let current: StyledParagraph[] = []

    for (const p of paragraphs) {
        if (p.type === "heading") {
            const level = p.level || 3
            const text = p.text.trim()
            if (shouldSplitAtHeading(text, level, current.length)) {
                chapters.push(makeChapter(chapters.length, currentTitle, current))
                const headingText = sanitizeHeadingText(text)
                currentTitle = headingText || `Section ${chapters.length + 1}`
                current = [{ ...p, text: headingText || p.text }]
                continue
            }

            if (current.length === 0 && level <= 2 && text) {
                currentTitle = sanitizeHeadingText(text)
            }
        }

        current.push(p)
    }

    if (current.length > 0) {
        chapters.push(makeChapter(chapters.length, currentTitle, current))
    }

    if (chapters.length === 1 && chapters[0]!.paragraphs.length > 180) {
        const chunkSize = 120
        const source = chapters[0]!
        const chunked: Chapter[] = []
        for (let i = 0; i < source.paragraphs.length; i += chunkSize) {
            const slice = source.paragraphs.slice(i, i + chunkSize)
            chunked.push(makeChapter(
                chunked.length,
                `${source.title} (Part ${chunked.length + 1})`,
                slice,
            ))
        }
        return chunked
    }

    return chapters.map((chapter, idx) => ({
        ...chapter,
        id: `ch-${idx}`,
        order: idx,
        title: chooseChapterTitle(chapter.paragraphs, chapter.title),
    }))
}

function isLikelyFrontMatterChapter(chapter: Chapter): boolean {
    const title = sanitizeHeadingText(chapter.title)
    if (!title) return true
    if (/^(preface|contents|table of contents)$/i.test(title)) return true
    if (/^[. ]*c\s+\d{4}\b/i.test(title)) return true
    if (/arpaci-dusseau books/i.test(title)) return true
    if (looksLikeTocishText(title)) return true

    const headings = chapter.paragraphs
        .filter((p) => p.type === "heading")
        .map((p) => sanitizeHeadingText(p.text || ""))
        .filter(Boolean)
        .slice(0, 8)

    if (headings.length === 0) return false

    const noisyHeadings = headings.filter(looksLikeTocishText).length
    return noisyHeadings >= Math.max(2, Math.ceil(headings.length * 0.5))
}

function finalizeParagraphsForChapters(paragraphs: StyledParagraph[]): StyledParagraph[] {
    const out: StyledParagraph[] = []

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i]!
        const text = (p.text || "").trim()
        if (!text && p.type !== "separator") continue

        if (p.type === "paragraph" && /^\d+(?:\.\d+)+$/.test(text)) {
            const next = paragraphs[i + 1]
            if (next && (next.type === "paragraph" || next.type === "heading")) {
                const nextText = (next.text || "").trim()
                if (nextText && nextText.length <= 90 && /^[A-Z][A-Za-z0-9()' ,:-]+$/.test(nextText)) {
                    out.push({ type: "heading", text: `${text} ${nextText}`, level: 2 })
                    i += 1
                    continue
                }
            }
        }

        if (p.type === "code") {
            if (text.length < 3) continue

            const lines = text.split("\n")
            if (lines.length <= 2) {
                const score = codeKeywordScore(text)
                const density = symbolDensity(text)
                const likelyCli = /^(-{1,2}\w|\w+\s+--?\w)/.test(text)
                const likelyCodeish = score >= 2 || density > 0.14 || /[{}()[\];=]/.test(text)
                if (!likelyCodeish && !likelyCli) {
                    out.push({ type: "paragraph", text: text.replace(/\s+/g, " ") })
                    continue
                }
            }

            if (/\bhttps?:\/\//i.test(text) && lines.length <= 2 && codeKeywordScore(text) < 2) {
                out.push({ type: "paragraph", text: text.replace(/\s+/g, " ") })
                continue
            }

            if (/^Figure \d+(?:\.\d+)*:/i.test(text)) {
                continue
            }
        }

        if (p.type === "heading") {
            p.text = sanitizeHeadingText(text)
            if ((text.match(/\./g) || []).length >= 8 && text.replace(/[.\s]/g, "").length < 25) {
                continue
            }

            if (/^[a-z]/.test(text) && !/^\d/.test(text)) {
                out.push({ type: "paragraph", text })
                continue
            }

            if (/^[A-Z].+\.$/.test(text) && !/^\d/.test(text)) {
                out.push({ type: "paragraph", text })
                continue
            }

            if (/^\d+\s+[A-Za-z]/.test(text)) {
                out.push({ type: "paragraph", text })
                continue
            }

            if (/^[A-Za-z].*\.{4,}\s*(?:\d+|[ivxlcdm]+)$/i.test(text)) {
                out.push({
                    type: "list-item",
                    text: text.replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim(),
                    ordered: false,
                    indent: 0,
                })
                continue
            }
        }

        out.push(p)
    }

    return out
}

function filterNoisyParagraphs(paragraphs: StyledParagraph[]): StyledParagraph[] {
    const out: StyledParagraph[] = []
    let headingStreak = 0
    let inToc = false
    let tocBudget = 0

    for (const p of paragraphs) {
        const text = (p.text || "").trim()
        if (!text && p.type !== "separator") continue

        if (p.type === "heading") {
            if (/^table of contents$/i.test(text)) {
                inToc = true
                tocBudget = 260
                out.push({ type: "heading", text: "Table of Contents", level: 2 })
                headingStreak += 1
                continue
            }

            if (
                /^\d+$/.test(text) ||
                text.length <= 2 ||
                /^\d{3,}$/.test(text) ||
                /^\d+\s+bytes?$/i.test(text) ||
                /^iv|v?i{1,3}|x{1,3}$/i.test(text) ||
                /^\.{8,}$/.test(text)
            ) {
                continue
            }

            if (inToc) {
                if (/^(chapter|section|part|appendix)\s+\w+/i.test(text)) {
                    inToc = false
                    tocBudget = 0
                } else {
                    if (/\.{4,}/.test(text) || /^\d+(?:\.\d+)*/.test(text)) {
                        out.push({
                            type: "list-item",
                            text: text.replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim(),
                            ordered: false,
                            indent: 0,
                        })
                        continue
                    }
                }
            }

            headingStreak += 1

            if (
                headingStreak > 4 &&
                text.length < 40 &&
                !/^(chapter|part|appendix|section|\d+\.)/i.test(text)
            ) {
                out.push({ type: "paragraph", text })
                continue
            }

            out.push(p)
            continue
        }

        if (p.type === "paragraph") {
            if (/^table of contents\s+/i.test(text)) {
                inToc = true
                tocBudget = Math.max(tocBudget, 200)
            }

            if (inToc && tocBudget > 0) {
                tocBudget--
                if (/^(chapter|section|part|appendix)\s+\w+/i.test(text)) {
                    inToc = false
                    tocBudget = 0
                } else {
                    if (isLikelyTocParagraph(text)) {
                        const cleaned = text
                            .replace(/^table of contents\s+/i, "")
                            .replace(/^\d+\s+/, "")
                            .replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "")
                            .trim()
                        if (!cleaned) continue
                        out.push({
                            type: "list-item",
                            text: cleaned,
                            ordered: false,
                            indent: 0,
                        })
                        continue
                    }
                }
            }

            if (/^\d+$/.test(text) || /^[ivxlcdm]+$/i.test(text)) {
                continue
            }

            if (/^\.{8,}$/.test(text)) {
                continue
            }

            if (/^\d+\s+\d+(?:\.\d+)*\.?\s+[A-Za-z]/.test(text)) {
                const cleaned = text
                    .replace(/^\d+\s+/, "")
                    .replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "")
                    .trim()
                if (!cleaned) continue
                out.push({
                    type: "list-item",
                    text: cleaned,
                    ordered: false,
                    indent: 0,
                })
                continue
            }

            if (isTocEntry(text)) {
                const cleaned = text.replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim()
                if (!cleaned) continue
                out.push({
                    type: "list-item",
                    text: cleaned,
                    ordered: false,
                    indent: 0,
                })
                continue
            }

            if (/^table of contents$/i.test(text)) {
                out.push({ type: "heading", text: "Table of Contents", level: 2 })
                continue
            }

            if (/^[ivxlcdm]+$/i.test(text) && text.length <= 6) {
                continue
            }

            if (/^(table of contents\s+)?\d+(?:\.\d+)*\.?\s+[A-Z].+\.{4,}\s*\d+$/i.test(text)) {
                const cleaned = text
                    .replace(/^table of contents\s+/i, "")
                    .replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "")
                    .trim()
                if (!cleaned) continue
                out.push({
                    type: "list-item",
                    text: cleaned,
                    ordered: false,
                    indent: 0,
                })
                continue
            }

            if (/^[A-Za-z].*\.{4,}\s*(?:\d+|[ivxlcdm]+)$/i.test(text)) {
                const cleaned = text.replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim()
                if (!cleaned) continue
                out.push({
                    type: "list-item",
                    text: cleaned,
                    ordered: false,
                    indent: 0,
                })
                continue
            }

            if (/^(chapter|section|part|appendix)\s+\w+/i.test(text)) {
                inToc = false
                tocBudget = 0
                out.push({ type: "heading", text, level: 2 })
                continue
            }

            if (/^\d+(?:\.\d+)+\s+[A-Z]/.test(text)) {
                out.push({ type: "heading", text, level: 3 })
                continue
            }

            if (/^\d+\.\s+[A-Z]/.test(text)) {
                out.push({ type: "heading", text, level: 2 })
                continue
            }
        }

        headingStreak = 0

        if (p.type === "code") {
            const lineCount = text.split("\n").length
            if (lineCount === 1 && text.length > 140 && symbolDensity(text) < 0.08) {
                out.push({ type: "paragraph", text: text.replace(/\s+/g, " ") })
                continue
            }
        }

        out.push(p)
    }

    return out
}

function layoutTextToSyntheticLines(text: string): BboxLine[] {
    const pages = text.split("\f")
    const lines: BboxLine[] = []

    for (let pi = 0; pi < pages.length; pi++) {
        const page = pages[pi] || ""
        const rawLines = page.split("\n")
        let y = 72

        for (const raw of rawLines) {
            const normalizedRaw = raw.replace(/\t/g, "    ").replace(/\s+$/g, "")
            const compact = normalizedRaw.trim().replace(/\s+/g, " ")
            if (!compact) {
                y += 12
                continue
            }

            const leadingSpaces = (normalizedRaw.match(/^\s*/) || [""])[0]!.length
            const xMin = 72 + leadingSpaces * 4
            const xMax = xMin + Math.max(1, compact.length) * 6

            lines.push({
                page: pi + 1,
                pageWidth: 612,
                pageHeight: 792,
                xMin,
                xMax,
                yMin: y,
                yMax: y + 11,
                raw: normalizedRaw,
                compact,
                words: [],
            })

            y += 12
        }
    }

    return lines
}

function parsePdfViaLayoutFallback(filePath: string, fallbackTitle: string): Chapter[] {
    try {
        const text = extractLayoutText(filePath)
        const syntheticLines = layoutTextToSyntheticLines(text)
        if (syntheticLines.length === 0) return []
        const paragraphs = mergeBrokenParagraphs(finalizeParagraphsForChapters(
            filterNoisyParagraphs(linesToStyledParagraphs(syntheticLines)),
        ))
        return buildChaptersFromParagraphs(paragraphs, fallbackTitle)
    } catch {
        return []
    }
}

/**
 * Parse a PDF file into structured book data.
 * Uses bbox-layout first for better structure reconstruction.
 */
export async function parsePdf(filePath: string): Promise<ParsedBook> {
    if (!hasPdfSupport()) {
        throw new Error(
            "pdftotext not found. Install poppler-utils:\n  sudo apt install poppler-utils",
        )
    }

    const info = getPdfInfo(filePath)
    const basename = filePath.split("/").pop() || "Untitled"
    const fallbackTitle = basename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ")

    const metadata: BookMetadata = {
        title: cleanPdfInfoValue(info.title) || fallbackTitle,
        author: cleanPdfInfoValue(info.author) || "Unknown",
        description: undefined,
    }

    let chapters: Chapter[] = []
    let totalWords = 0

    try {
        const bboxHtml = extractBboxLayout(filePath)
        const rawLines = parseBboxLines(bboxHtml)
        const contentLines = dropFrontMatterPages(rawLines)
        const filteredLines = filterRepeatedMarginLines(contentLines)
        const paragraphs = mergeBrokenParagraphs(finalizeParagraphsForChapters(
            filterNoisyParagraphs(linesToStyledParagraphs(filteredLines)),
        ))
        chapters = buildChaptersFromParagraphs(paragraphs, metadata.title)
        totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)
    } catch {
        // Fallback below.
    }

    if (chapters.length === 0 || totalWords < 100) {
        const fallbackChapters = parsePdfViaLayoutFallback(filePath, metadata.title)
        const fallbackWords = fallbackChapters.reduce((sum, ch) => sum + ch.wordCount, 0)
        if (fallbackWords > totalWords) {
            chapters = fallbackChapters
            totalWords = fallbackWords
        }
    }

    if (chapters.length > 1 && chapters[0]!.wordCount < 80) {
        chapters = chapters.slice(1).map((ch, idx) => ({ ...ch, id: `ch-${idx}`, order: idx }))
        totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)
    }

    if (
        chapters.length > 1 &&
        /^(contents|table of contents)$/i.test(chapters[0]!.title.trim())
    ) {
        chapters = chapters.slice(1).map((ch, idx) => ({ ...ch, id: `ch-${idx}`, order: idx }))
        totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)
    }

    while (chapters.length > 1 && isLikelyFrontMatterChapter(chapters[0]!)) {
        chapters = chapters.slice(1).map((ch, idx) => ({ ...ch, id: `ch-${idx}`, order: idx }))
    }

    totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)

    const metadataTitleLower = metadata.title.toLowerCase().trim()
    chapters = chapters
        .map((ch, idx) => ({ ...ch, id: `ch-${idx}`, order: idx }))
        .filter((ch, idx) => {
            if (idx === 0) return true
            const title = ch.title.toLowerCase().trim()
            if (!title) return false
            if (title === "contents" || title === "table of contents") return false
            if (title === metadataTitleLower) return false
            return true
        })

    totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)

    if (chapters.length === 0) {
        throw new Error("Could not extract readable text from this PDF")
    }

    return {
        metadata,
        chapters,
        totalWords,
    }
}
