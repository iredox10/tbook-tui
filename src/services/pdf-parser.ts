// ─────────────────────────────────────────────────────────────
// PDF Parser — high-fidelity extraction for all book types
// Primary: pdftohtml -xml (with fontspec, outline, images)
// Fallback: pdftotext -layout
// ─────────────────────────────────────────────────────────────

import { execFileSync } from "child_process"
import { parse as parseHTML } from "node-html-parser"
import { detectLanguageFromContent } from "../utils/syntax-highlight"
import type { StyledParagraph } from "../utils/html-to-text"
import type { BookMetadata, Chapter, ParsedBook } from "./epub-parser"
import { loadConfig, type TBookConfig } from "./config"
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from "fs"
import { join, basename, dirname } from "path"
import { homedir } from "os"
import { createHash } from "crypto"

// ═══════════════════════════════════════════════════════════
// Intermediate model types (Phase 0)
// ═══════════════════════════════════════════════════════════

interface PdfFontSpec {
    id: number
    size: number
    family: string
    color: string
}

interface PdfTextRun {
    text: string
    fontId: number
    bold: boolean
    italic: boolean
    href: string | null
    xMin: number
    xMax: number
    yMin: number
    yMax: number
    width: number
    height: number
    color: string
    family: string
}

interface PdfLine {
    page: number
    pageWidth: number
    pageHeight: number
    xMin: number
    xMax: number
    yMin: number
    yMax: number
    raw: string
    compact: string
    runs: PdfTextRun[]
    avgFontSize: number
    family: string
    color: string
    bold: boolean
    italic: boolean
    href: string | null
    startPage: boolean
}

interface PdfOutlineItem {
    title: string
    page: number
    children: PdfOutlineItem[]
}

interface PdfImage {
    page: number
    left: number
    top: number
    width: number
    height: number
    src: string
}

interface PdfMetrics {
    bodyLineHeight: number
    bodyLeft: number
    bodyFontSize: number
    pageWidth: number
}

// ═══════════════════════════════════════════════════════════
// Utility helpers
// ═══════════════════════════════════════════════════════════

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
 * PDF support requires pdftohtml. pdftotext/pdfinfo are optional helpers.
 */
export function hasPdfSupport(): boolean {
    return hasCommand("pdftohtml")
}

export function hasOcrSupport(): boolean {
    return hasCommand("tesseract") || hasCommand("ocrmypdf")
}

function hasPdftotext(): boolean {
    return hasCommand("pdftotext")
}

function hasPdfinfo(): boolean {
    return hasCommand("pdfinfo")
}

function parseNum(value: string | undefined, fallback = 0): number {
    const n = parseFloat(value || "")
    return Number.isFinite(n) ? n : fallback
}

function median(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2
    return sorted[mid]!
}

function normalizeWordText(text: string): string {
    return text
        .replace(/\u00a0/g, " ")
        .replace(/[\t\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

// ═══════════════════════════════════════════════════════════
// HTML entity decoding (Phase 0)
// ═══════════════════════════════════════════════════════════

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#34;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&nbsp;/g, " ")
        .replace(/&#160;/g, " ")
}

// ═══════════════════════════════════════════════════════════
// PDF info extraction
// ═══════════════════════════════════════════════════════════

interface PdfInfo {
    title?: string
    author?: string
    pages: number
    encrypted: boolean
}

function readPdfInfoField(info: string, key: string): string | undefined {
    const match = info.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))
    const value = match?.[1]?.trim()
    return value ? value : undefined
}

function getPdfInfo(filePath: string): PdfInfo {
    try {
        if (!hasPdfinfo()) return { pages: 0, encrypted: false }
        const info = run("pdfinfo", [filePath], 8 * 1024 * 1024)
        const pages = parseInt(readPdfInfoField(info, "Pages") || "0", 10)
        const encrypted = /encrypted|Encrypted/.test(info)
        return {
            title: readPdfInfoField(info, "Title"),
            author: readPdfInfoField(info, "Author"),
            pages: Number.isFinite(pages) ? pages : 0,
            encrypted,
        }
    } catch {
        return { pages: 0, encrypted: false }
    }
}

// ═══════════════════════════════════════════════════════════
// Image cache helpers (Phase 3)
// ═══════════════════════════════════════════════════════════

function getImageCacheDir(filePath: string): string {
    const hash = createHash("md5").update(filePath).digest("hex")
    const dir = join(homedir(), ".tbook", "cache", "pdf-images", hash)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
}

function cleanStaleImageCache(maxAgeDays = 30): void {
    const baseDir = join(homedir(), ".tbook", "cache", "pdf-images")
    if (!existsSync(baseDir)) return
    try {
        const dirs = readdirSync(baseDir)
        const now = Date.now()
        const maxAge = maxAgeDays * 24 * 60 * 60 * 1000
        for (const dir of dirs) {
            const dirPath = join(baseDir, dir)
            try {
                const st = statSync(dirPath)
                if (now - st.mtimeMs > maxAge) {
                    const files = readdirSync(dirPath)
                    for (const f of files) unlinkSync(join(dirPath, f))
                    unlinkSync(dirPath)
                }
            } catch { /* skip */ }
        }
    } catch { /* skip */ }
}

function copyImagesToCache(xmlDir: string, cacheDir: string): Map<string, string> {
    const map = new Map<string, string>()
    if (!existsSync(xmlDir)) return map
    try {
        for (const entry of readdirSync(xmlDir)) {
            const ext = entry.toLowerCase()
            if (!ext.endsWith(".png") && !ext.endsWith(".jpg") && !ext.endsWith(".jpeg")) continue
            const src = join(xmlDir, entry)
            const dest = join(cacheDir, entry)
            try {
                copyFileSync(src, dest)
                map.set(entry, dest)
                map.set(basename(entry, ext.replace(/^\./, "")), dest)
            } catch { /* skip */ }
        }
    } catch { /* skip */ }
    return map
}

// ═══════════════════════════════════════════════════════════
// pdftohtml invocation with image support (Phase 3)
// ═══════════════════════════════════════════════════════════

function extractPdfToXml(filePath: string): { xml: string; workDir: string } {
    const workDir = getImageCacheDir(filePath)
    const xmlFile = join(workDir, "output.xml")
    run(
        "pdftohtml",
        [
            "-xml",
            "-enc", "UTF-8",
            "-q",
            "-fmt", "png",
            filePath,
            xmlFile,
        ],
        512 * 1024 * 1024,
    )
    const { readFileSync } = require("fs")
    const xml = readFileSync(xmlFile, "utf-8")
    return { xml, workDir }
}

function extractLayoutText(filePath: string): string {
    return run(
        "pdftotext",
        ["-layout", "-enc", "UTF-8", filePath, "-"],
        64 * 1024 * 1024,
    )
}

// ═══════════════════════════════════════════════════════════
// Fontspec parsing (Phase 1)
// ═══════════════════════════════════════════════════════════

function parseFontSpecs(root: ReturnType<typeof parseHTML>): Map<number, PdfFontSpec> {
    const specs = new Map<number, PdfFontSpec>()
    const fontNodes = root.querySelectorAll("fontspec")
    for (const fn of fontNodes) {
        const id = parseNum(fn.getAttribute("id"), -1)
        if (id < 0) continue
        specs.set(id, {
            id,
            size: parseNum(fn.getAttribute("size"), 10),
            family: fn.getAttribute("family") || "sans-serif",
            color: fn.getAttribute("color") || "#000000",
        })
    }
    return specs
}

// ═══════════════════════════════════════════════════════════
// Outline parsing (Phase 2)
// ═══════════════════════════════════════════════════════════

function parseOutline(root: ReturnType<typeof parseHTML>): PdfOutlineItem[] {
    const outlineNodes = root.querySelectorAll("outline > item")
    if (outlineNodes.length === 0) return []

    function walk(node: any): PdfOutlineItem | null {
        const title = decodeHtmlEntities(node.getAttribute("title") || "").trim()
        const page = parseNum(node.getAttribute("page"), 0)
        if (!title) return null
        const children: PdfOutlineItem[] = []
        const childNodes = node.querySelectorAll(":scope > item")
        for (const child of childNodes) {
            const result = walk(child)
            if (result) children.push(result)
        }
        return { title, page, children }
    }

    const items: PdfOutlineItem[] = []
    for (const node of outlineNodes) {
        const result = walk(node)
        if (result) items.push(result)
    }
    return items
}

function flattenOutline(items: PdfOutlineItem[]): { title: string; page: number }[] {
    const flat: { title: string; page: number }[] = []
    function visit(item: PdfOutlineItem) {
        flat.push({ title: item.title, page: item.page })
        for (const child of item.children) visit(child)
    }
    for (const item of items) visit(item)
    return flat
}

// ═══════════════════════════════════════════════════════════
// Bbox line extraction with fontspec and image support (Phase 0-3)
// ═══════════════════════════════════════════════════════════

function parseBboxLines(
    xml: string,
    fontSpecs: Map<number, PdfFontSpec>,
): { lines: PdfLine[]; images: PdfImage[] } {
    const root = parseHTML(xml, {
        lowerCaseTagName: true,
        blockTextElements: {
            script: false,
            style: false,
            pre: true,
        },
    })

    const lines: PdfLine[] = []
    const images: PdfImage[] = []
    const pageNodes = root.querySelectorAll("page")

    for (let pageIdx = 0; pageIdx < pageNodes.length; pageIdx++) {
        const pageNode = pageNodes[pageIdx]!
        const pageNumber = pageIdx + 1
        const pageWidth = parseNum(pageNode.getAttribute("width"), 612)
        const pageHeight = parseNum(pageNode.getAttribute("height"), 792)

        const children = pageNode.childNodes
        let isFirstTextOnPage = true
        const pageRuns: PdfTextRun[] = []

        for (const node of children) {
            const nodeName = (node as any).tagName?.toLowerCase()
            if (!nodeName) continue

            // Parse images (Phase 3)
            if (nodeName === "image") {
                const src = (node as any).getAttribute?.("src") || ""
                const left = parseNum((node as any).getAttribute?.("left"), 0)
                const top = parseNum((node as any).getAttribute?.("top"), 0)
                const width = parseNum((node as any).getAttribute?.("width"), 0)
                const height = parseNum((node as any).getAttribute?.("height"), 0)
                if (src) {
                    images.push({ page: pageNumber, left, top, width, height, src })
                }
                continue
            }

            if (nodeName !== "text") continue
            const textNode = node as any
            const innerHtml = textNode.innerHTML || ""

            const fontId = parseNum(textNode.getAttribute?.("font"), -1)
            const fontSize = fontId >= 0 ? (fontSpecs.get(fontId)?.size || 10) : 10
            const fontFamily = fontId >= 0 ? (fontSpecs.get(fontId)?.family || "sans-serif") : "sans-serif"
            const fontColor = fontId >= 0 ? (fontSpecs.get(fontId)?.color || "#000000") : "#000000"

            const xMin = parseNum(textNode.getAttribute?.("left"), 0)
            const yMin = parseNum(textNode.getAttribute?.("top"), 0)
            const width = parseNum(textNode.getAttribute?.("width"), 0)
            const height = parseNum(textNode.getAttribute?.("height"), 0)
            const xMax = xMin + width
            const yMax = yMin + height

            // Parse inline bold/italic/link from inner XML (Phase 0-1)
            const runParts = parseInlineRuns(innerHtml)
            for (const part of runParts) {
                const text = normalizeWordText(decodeHtmlEntities(part.text))
                if (!text) continue

                pageRuns.push({
                    text,
                    fontId,
                    bold: part.bold,
                    italic: part.italic,
                    href: part.href,
                    xMin,
                    xMax,
                    yMin,
                    yMax,
                    width,
                    height,
                    color: fontColor,
                    family: fontFamily,
                })
            }
        }

        // Merge same-baseline runs into logical lines (Phase 1)
        const pageLines = mergeRunsIntoLines(pageRuns, pageNumber, pageWidth, pageHeight)
        lines.push(...pageLines)
    }

    return { lines, images }
}

interface InlineRunPart {
    text: string
    bold: boolean
    italic: boolean
    href: string | null
}

function parseInlineRuns(innerHtml: string): InlineRunPart[] {
    const parts: InlineRunPart[] = []

    function extract(node: any, bold: boolean, italic: boolean, href: string | null): void {
        if (!node) return

        if (node.nodeType === 3) {
            const text = node.rawText || node.textContent || ""
            if (text) {
                parts.push({ text, bold, italic, href })
            }
            return
        }

        const tag = (node.tagName || "").toLowerCase()
        if (tag === "b" || tag === "strong") {
            for (const child of node.childNodes || []) extract(child, true, italic, href)
        } else if (tag === "i" || tag === "em") {
            for (const child of node.childNodes || []) extract(child, bold, true, href)
        } else if (tag === "a") {
            const aHref = node.getAttribute?.("href") || null
            for (const child of node.childNodes || []) extract(child, bold, italic, aHref || href)
        } else {
            for (const child of node.childNodes || []) extract(child, bold, italic, href)
        }
    }

    const root = parseHTML(innerHtml, { lowerCaseTagName: true })
    extract(root, false, false, null)

    // Clean up whitespace-only parts, normalize text
    return parts.filter(p => {
        p.text = normalizeWordText(p.text)
        return p.text.length > 0
    })
}

function mergeRunsIntoLines(
    runs: PdfTextRun[],
    pageNumber: number,
    pageWidth: number,
    pageHeight: number,
): PdfLine[] {
    if (runs.length === 0) return []

    // Group runs by yMin within tolerance
    const tolerance = 0.5
    const groups: PdfTextRun[][] = []
    let current: PdfTextRun[] = []
    let currentY = -1

    for (const run of runs) {
        if (currentY < 0 || Math.abs(run.yMin - currentY) <= tolerance) {
            current.push(run)
            currentY = currentY < 0 ? run.yMin : currentY
        } else {
            if (current.length > 0) groups.push(current)
            current = [run]
            currentY = run.yMin
        }
    }
    if (current.length > 0) groups.push(current)

    const lines: PdfLine[] = []

    for (const group of groups) {
        // Sort by xMin
        group.sort((a, b) => a.xMin - b.xMin)

        // Build line text with proper spacing between runs
        let rawText = ""
        let prev: PdfTextRun | null = null

        for (const run of group) {
            if (prev) {
                const gap = run.xMin - prev.xMax
                const avgCharWidth = Math.max(3, (prev.xMax - prev.xMin) / Math.max(1, prev.text.length))
                if (gap > avgCharWidth * 3.2) rawText += "   "
                else if (gap > avgCharWidth * 1.8) rawText += "  "
                else if (gap > avgCharWidth * 0.4) rawText += " "
            }
            rawText += run.text
            prev = run
        }

        rawText = rawText.trimEnd()
        const compact = rawText.replace(/\s+/g, " ").trim()

        if (!compact) continue

        const xMin = group[0]!.xMin
        const xMax = group[group.length - 1]!.xMax
        const yMin = group[0]!.yMin
        const yMax = Math.max(...group.map(r => r.yMax))
        const avgFontSize = group.reduce((s, r) => s + r.height, 0) / group.length
        const hasBold = group.some(r => r.bold)
        const hasItalic = group.some(r => r.italic)
        const href = group.find(r => r.href)?.href || null
        const family = group[0]!.family
        const color = group[0]!.color

        lines.push({
            page: pageNumber,
            pageWidth,
            pageHeight,
            xMin,
            xMax,
            yMin,
            yMax,
            raw: rawText,
            compact,
            runs: group,
            avgFontSize,
            family,
            color,
            bold: hasBold,
            italic: hasItalic,
            href,
            startPage: xMin <= pageWidth * 0.15,
        })
    }

    // Sort by page, then y, then x (reading order, Phase 1)
    return lines.sort((a, b) => a.page - b.page || a.yMin - b.yMin || a.xMin - b.xMin)
}

// ═══════════════════════════════════════════════════════════
// Metrics computation (Phase 1 - font-size aware)
// ═══════════════════════════════════════════════════════════

function isMarginLine(line: PdfLine): boolean {
    const topRatio = line.yMin / Math.max(1, line.pageHeight)
    const bottomRatio = line.yMax / Math.max(1, line.pageHeight)
    return topRatio < 0.1 || bottomRatio > 0.9
}

function computeMetrics(lines: PdfLine[]): PdfMetrics {
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
    const bodyLeft = median(lefts) || 72

    const widths = lines.map(line => line.pageWidth).filter(v => v > 0)
    const pageWidth = median(widths) || 612

    const bodyFontSizes = bodyCandidates
        .map(line => line.avgFontSize)
        .filter(v => v > 0)
    const bodyFontSize = median(bodyFontSizes) || 10

    return { bodyLineHeight, bodyLeft, bodyFontSize, pageWidth }
}

// ═══════════════════════════════════════════════════════════
// Heading detection — font-size primary, patterns secondary (Phase 1, 4)
// ═══════════════════════════════════════════════════════════

function looksLikeTocLine(line: PdfLine): boolean {
    const text = line.compact
    if (!text) return false
    if (/^\d+(?:\.\d+)*\.?\s+.+\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i.test(text)) return true
    if (/^\d+\s+\d+(?:\.\d+)*\.?\s+[A-Za-z]/.test(text)) return true
    if (/^\d+(?:\.\d+)*\.?\s+.+\.{4,}\s*[ivxlcdm]+$/i.test(text)) return true
    if (/^\.{8,}$/.test(text)) return true
    return /^table of contents$/i.test(text)
}

function isTocEntry(text: string): boolean {
    return /^\d+(?:\.\d+)*\.?\s+.+\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i.test(text)
}

function symbolDensity(text: string): number {
    const plain = text.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "")
    const symbols = (plain.match(/[{}()[\];:=<>+\-*/%$#@`|\\~]/g) || []).length
    return symbols / Math.max(1, plain.length)
}

function looksLikeDiagramLabel(text: string): boolean {
    if (/^figure\b/i.test(text)) return true
    if (/^[.=0-9]/.test(text) && text.length <= 12) return true
    if (/^[A-Z]{1,4}$/.test(text)) return true
    if (/^\d+\s*(KB|MB|GB|TB|%|ms|us|ns|s|m|h)$/i.test(text)) return true
    if (/^[A-Z0-9 ]+$/.test(text) && text.length <= 6) return true
    if (/^[A-Z][a-z]+$/.test(text) && text.length <= 7) return true
    return false
}

function detectHeading(line: PdfLine, metrics: PdfMetrics): { isHeading: boolean; level: number } {
    const text = line.compact
    if (!text || text.length > 140) return { isHeading: false, level: 0 }
    if (/^\.{8,}$/.test(text)) return { isHeading: false, level: 0 }
    if (looksLikeTocLine(line)) return { isHeading: false, level: 0 }
    if (looksLikeDiagramLabel(text)) return { isHeading: false, level: 0 }

    // Reject garbage text from bad font extraction
    if (/[~^]{2,}/.test(text) || /(,\s*){3,}/.test(text) || symbolDensity(text) > 0.3) {
        return { isHeading: false, level: 0 }
    }

    // Reject short italic quote fragments or attribution names as headings (Phase 4)
    if (line.italic && text.length < 50 && !/^(chapter|part|appendix|section|\d+\.)/i.test(text)) {
        return { isHeading: false, level: 0 }
    }

    // Reject multi-sentence running text that looks like a paragraph
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

    // Strong pattern matches (primary boost)
    if (/^(chapter|part|appendix)\s+\w+/i.test(text)) return { isHeading: true, level: 1 }
    if (/^section\s+\d+/i.test(text)) return { isHeading: true, level: 2 }
    if (/^\d+\.\s+[A-Z]/.test(text)) return { isHeading: true, level: 2 }
    if (/^\d+\.\d+\s+[A-Z]/.test(text)) return { isHeading: true, level: 3 }

    // Font-size based detection (Phase 1 — primary)
    const bodySize = Math.max(1, metrics.bodyFontSize)
    const ratio = line.avgFontSize / bodySize

    // Strong size difference -> heading regardless of pattern
    if (ratio >= 1.6) return { isHeading: true, level: 1 }
    if (ratio >= 1.35) return { isHeading: true, level: 2 }
    if (ratio >= 1.15 && text.length <= 100) return { isHeading: true, level: 3 }

    // Pattern-based fallbacks (secondary)
    if (/^[a-z]/.test(text) && !/^\d/.test(text)) return { isHeading: false, level: 0 }
    if (/^[A-Z].+\.$/.test(text) && !/^\d/.test(text)) return { isHeading: false, level: 0 }

    const h = Math.max(1, line.yMax - line.yMin)
    const hRatio = h / Math.max(1, metrics.bodyLineHeight)
    if (hRatio >= 1.9) return { isHeading: true, level: 1 }
    if (hRatio >= 1.45) return { isHeading: true, level: 2 }

    const width = line.xMax - line.xMin
    const centered = line.xMin > metrics.bodyLeft + metrics.bodyLineHeight && width < metrics.pageWidth * 0.72
    if (centered && text.length <= 90 && text.length >= 4 && line.avgFontSize >= bodySize * 1.1) {
        return { isHeading: true, level: 2 }
    }

    if (text === text.toUpperCase() && text.length <= 60 && /[A-Z]{3,}/.test(text) && !/^\d/.test(text)) {
        return { isHeading: true, level: 2 }
    }

    return { isHeading: false, level: 0 }
}

// ═══════════════════════════════════════════════════════════
// Content profile detection (Phase 4)
// ═══════════════════════════════════════════════════════════

type BookProfile = "programming" | "narrative" | "mixed"

function detectBookProfile(lines: PdfLine[]): BookProfile {
    const sample = lines.slice(0, Math.min(200, lines.length))
    let codeSignals = 0
    let narrativeSignals = 0
    let totalWords = 0

    for (const line of sample) {
        const text = line.compact
        if (!text) continue
        const words = text.split(/\s+/).length
        totalWords += words

        const density = symbolDensity(text)
        if (density > 0.1 && words <= 16) codeSignals++
        if (/\b(function|const|let|var|class\s+\w|interface\s+\w|def\s+\w|import\s+\w|fn\s+\w|struct\s+\w)\b/.test(text)) codeSignals += 2
        if (/\b(the|and|or|but|that|this|these|those)\b/i.test(text) && words > 4) narrativeSignals++
        if (line.italic && words > 4) narrativeSignals++

        // Monospace font family suggests code
        if (/\b(courier|mono|consolas|menlo|monaco)\b/i.test(line.family)) codeSignals += 3
    }

    if (codeSignals > narrativeSignals * 1.5) return "programming"
    if (narrativeSignals > codeSignals * 2) return "narrative"
    return "mixed"
}

// ═══════════════════════════════════════════════════════════
// Code detection with profile gate (Phase 4)
// ═══════════════════════════════════════════════════════════

function codeKeywordScore(text: string): number {
    const plain = text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1")
    let score = 0
    if (/\b(function|const|let|var|interface|namespace|export\s+default|import\s+.+\s+from|class\s+\w+\s*[{:]|class\s+\w+\s+extends)\b/.test(plain)) score += 2
    if (/\b(def\s+\w+\s*\(|from\s+\w+\s+import|async\s+def|lambda\b|except\s+\w+|elif\s+.+:)\b/.test(plain)) score += 2
    if (/\b(fn\s+\w+\s*\(|impl\s+\w+|struct\s+\w+|enum\s+\w+|trait\s+\w+|pub\s+fn|use\s+\w+::|match\s+\w+)\b/.test(plain)) score += 2
    if (/\b(func\s+\w+\s*\(|package\s+\w+|go\s+func|defer\s+\w+|type\s+\w+\s+struct|interface\s*\{)\b/.test(plain)) score += 2
    if (/\bSELECT\b.+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bCREATE\s+(TABLE|INDEX|VIEW)\b|\bALTER\s+TABLE\b/i.test(plain)) score += 2
    if (/\b(typedef|struct|enum|union|template|#include|using\s+namespace)\b/.test(plain)) score += 2
    if (/=>|->|::|\{\}|\(\)|;\s*$/.test(plain)) score += 1
    if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*\{?$/.test(plain)) score += 1
    return score
}

function looksLikeCodeLine(line: PdfLine, metrics: PdfMetrics, profile: BookProfile): boolean {
    const text = line.compact
    if (!text) return false
    if (looksLikeTocLine(line)) return false

    const keywords = codeKeywordScore(text)
    if (text.length > 220 && symbolDensity(text) < 0.05 && keywords === 0) return false
    if (text.length > 120 && symbolDensity(text) < 0.06 && keywords === 0) return false
    if (/\bhttps?:\/\/\S+/i.test(text) && keywords === 0) return false

    if (keywords === 0 && (/[~]{2,}/.test(text) || /(~\s*){2,}/.test(text) || /(,\s*){3,}/.test(text))) {
        return false
    }

    // Profile gate (Phase 4): narrative mode requires stronger code evidence
    const indent = line.xMin - metrics.bodyLeft
    const density = symbolDensity(text)
    const punctuation = /[{}()[\];=<>]/.test(text)
    const isMonospace = /\b(courier|mono|consolas|menlo|monaco|monospace)\b/i.test(line.family)

    // In narrative mode, require very strong evidence
    if (profile === "narrative") {
        if (keywords >= 3 && (indent > 0 || punctuation)) return true
        if (isMonospace && (keywords >= 1 || density > 0.08 || indent > metrics.bodyLineHeight * 0.6)) return true
        if (/^(\$ |>>> |\.{3} |In \[\d+\]:|Out\[\d+\]:)/.test(text)) return true
        if (/^#(include|define|ifdef|ifndef|endif|if|else|elif)\b/.test(text)) return true
        if (/^(\/\/|#\s|\/\*|\*\s)/.test(text)) return true
        if (density > 0.2 && punctuation && text.length < 80) return true
        return false
    }

    // Programming/mixed mode: existing heuristics
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
    if (line.avgFontSize < bodyFontSize(line, metrics) * 0.92 && density > 0.1 && punctuation) return true
    if (/;\s*$/.test(text) && (keywords > 0 || punctuation)) return true
    if (keywords === 1 && text.length < 64 && punctuation && density > 0.08) return true
    if (keywords >= 1 && punctuation && text.length < 100 && density > 0.06) return true

    return false
}

function bodyFontSize(line: PdfLine, metrics: PdfMetrics): number {
    return Math.max(1, metrics.bodyFontSize)
}

function shouldStartNewCodeBlock(text: string, metrics: PdfMetrics, xMin: number, profile: BookProfile): boolean {
    const indent = xMin - metrics.bodyLeft
    if (/\bhttps?:\/\/\S+/i.test(text) && codeKeywordScore(text) === 0) return false

    if (profile === "narrative") {
        if (indent > metrics.bodyLineHeight * 1.0) return true
        if (codeKeywordScore(text) >= 3) return true
        if (/^(\$ |>>> |\.{3} |In \[\d+\]:|Out\[\d+\]:)/.test(text)) return true
        if (/^#(include|define|ifdef|ifndef|endif|if|else|elif)\b/.test(text)) return true
        if (/^(\/\/|#\s|\/\*|\*\s)/.test(text)) return true
        if (symbolDensity(text) > 0.15 && text.length < 70) return true
        return false
    }

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

function shouldContinueCodeBlock(text: string, line: PdfLine, prev: PdfLine | null, metrics: PdfMetrics): boolean {
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

// ═══════════════════════════════════════════════════════════
// Table detection improvements (Phase 4)
// ═══════════════════════════════════════════════════════════

function looksLikeTableBlock(lines: PdfLine[]): boolean {
    if (lines.length < 2) return false

    // Check for consistent multi-column y-bands
    const pageBands = new Map<number, PdfLine[]>()
    for (const line of lines) {
        const key = line.page
        if (!pageBands.has(key)) pageBands.set(key, [])
        pageBands.get(key)!.push(line)
    }

    for (const pageLines of pageBands.values()) {
        if (pageLines.length < 2) continue

        // Check for lines sharing same y position (multiple columns on same row)
        const yGroups = new Map<number, PdfLine[]>()
        for (const line of pageLines) {
            let found = false
            for (const [y] of yGroups) {
                if (Math.abs(line.yMin - y) < 4) {
                    yGroups.get(y)!.push(line)
                    found = true
                    break
                }
            }
            if (!found) yGroups.set(line.yMin, [line])
        }

        // Need at least 2 rows with 2+ columns each
        let multiColumnRows = 0
        for (const group of yGroups.values()) {
            if (group.length >= 2) multiColumnRows++
        }
        if (multiColumnRows >= 2) return true

        // Also check if lines have multiple space-delimited columns
        let multiSpaceCount = 0
        for (const line of pageLines) {
            const cols = line.raw.trim().split(/\s{2,}/).filter(Boolean)
            if (cols.length >= 3) multiSpaceCount++
        }
        if (multiSpaceCount >= 2) return true
    }

    return false
}

function parseTableRowsFromCluster(lines: PdfLine[]): string[][] {
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

// ═══════════════════════════════════════════════════════════
// Blockquote detection (Phase 4)
// ═══════════════════════════════════════════════════════════

function looksLikeBlockquote(lines: PdfLine[], metrics: PdfMetrics): boolean {
    if (lines.length < 1) return false
    const italics = lines.filter(l => l.italic).length
    const total = lines.length
    const indentCount = lines.filter(l => l.xMin > metrics.bodyLeft + metrics.bodyLineHeight * 0.5).length

    // Multi-line italic block -> quote
    if (total >= 2 && italics >= total * 0.6) return true
    // Indented cluster -> quote
    if (total >= 3 && indentCount >= total * 0.7) return true
    return false
}

// ═══════════════════════════════════════════════════════════
// Note/List/Header-footer helpers
// ═══════════════════════════════════════════════════════════

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

function looksLikeListItem(text: string): { isList: boolean; ordered: boolean; indent: number; index?: number; body: string } {
    const bullet = text.match(/^\s*([-*+•●◦▪▸])\s+(.+)$/)
    if (bullet) return { isList: true, ordered: false, indent: 0, body: bullet[2]! }

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

function parseListItem(line: PdfLine, metrics: PdfMetrics): { isList: boolean; ordered: boolean; indent: number; index?: number; body: string } {
    const parsed = looksLikeListItem(line.raw)
    if (!parsed.isList) return parsed
    const relativeIndent = Math.max(0, line.xMin - metrics.bodyLeft)
    const indent = Math.max(0, Math.round(relativeIndent / Math.max(8, metrics.bodyLineHeight * 1.2)))
    return { ...parsed, indent }
}

function normalizeHeaderFooterKey(text: string): string {
    return text
        .toLowerCase()
        .replace(/\bpage\s+\d+\b/g, "page #")
        .replace(/\d+/g, "#")
        .replace(/\s+/g, " ")
        .trim()
}

function filterRepeatedMarginLines(lines: PdfLine[]): PdfLine[] {
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

// ═══════════════════════════════════════════════════════════
// Markdown-style emphasis markers (Phase 1)
// ═══════════════════════════════════════════════════════════

function applyEmphasisMarkers(line: PdfLine): string {
    let text = line.compact
    const hasBold = line.runs.some(r => r.bold)
    const hasItalic = line.runs.some(r => r.italic)

    if (hasBold && hasItalic) {
        return `***${text}***`
    }
    if (hasBold) {
        return `**${text}**`
    }
    if (hasItalic) {
        return `*${text}*`
    }
    return text
}

function stripEmphasisMarkers(text: string): string {
    return text
        .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*\n]+)\*/g, "$1")
}

// ═══════════════════════════════════════════════════════════
// Sanitization and text helpers
// ═══════════════════════════════════════════════════════════

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
        const plain = token.replace(/[`'"",.;:!?()[\]{}]+/g, "")
        const next = tokens[i + 1]?.replace(/[`'"",.;:!?()[\]{}]+/g, "") || ""

        if (
            kept.length >= 1 &&
            stopTokens.has(plain) &&
            (!next || /^[a-z]/.test(next) || /^\d/.test(next) || plain === "Figure" || plain === "Table")
        ) {
            break
        }

        kept.push(token)
        if (kept.length >= 10 && /[.?!:]$/.test(token)) break
    }

    const candidate = `${prefix} ${kept.join(" ")}`.replace(/\s+/g, " ").trim()
    return candidate.length >= prefix.length + 4 ? candidate : text
}

function sanitizeHeadingText(text: string): string {
    return stripEmphasisMarkers(trimInlineHeadingBody(normalizeSpacedCaps(text)))
}

function joinProseLines(lines: string[]): string {
    let out = ""
    for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        if (!out) { out = line; continue }
        if (out.endsWith("-") && /^[a-z]/.test(line)) {
            out = out + line
            continue
        }
        out += " " + line
    }
    return out.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim()
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

function countWords(paragraphs: StyledParagraph[]): number {
    return paragraphs.reduce((sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length, 0)
}

// ═══════════════════════════════════════════════════════════
// Front matter handling (Phase 5)
// ═══════════════════════════════════════════════════════════

function dropFrontMatterPages(lines: PdfLine[], config: TBookConfig): PdfLine[] {
    if (lines.length === 0) return lines

    if ((config as any).pdf?.showFrontMatter) return lines

    const byPage = new Map<number, PdfLine[]>()
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

        if (i > 0) break
    }

    const filtered = lines.filter(line => line.page >= startPage)
    return filtered.length > 0 ? filtered : lines
}

function isLikelyFrontMatterChapter(chapter: Chapter): boolean {
    const title = sanitizeHeadingText(chapter.title)
    if (!title) return true
    if (/^(preface|contents|table of contents|title page|copyright|acknowledgements|about this book|imprint)$/i.test(title)) return true
    if (/^[. ]*c\s+\d{4}\b/i.test(title)) return true
    if (/arpaci-dusseau books/i.test(title)) return true

    const headings = chapter.paragraphs
        .filter((p) => p.type === "heading")
        .map((p) => sanitizeHeadingText(p.text || ""))
        .filter(Boolean)
        .slice(0, 8)

    if (headings.length === 0) return false
    const tocLike = headings.filter(h => /\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i.test(h)).length
    return tocLike >= Math.max(2, Math.ceil(headings.length * 0.5))
}

// ═══════════════════════════════════════════════════════════
// Paragraph construction pipeline
// ═══════════════════════════════════════════════════════════

function insertImagesIntoLines(lines: PdfLine[], images: PdfImage[]): PdfLine[] {
    if (images.length === 0) return lines

    // For each image, create a synthetic "line" at the image's position
    const result: (PdfLine | { page: number; xMin: number; xMax: number; yMin: number; yMax: number; isImage: true; image: PdfImage })[] = [...lines]

    const MIN_IMG_WIDTH = 30
    const MIN_IMG_HEIGHT = 30

    for (const img of images) {
        if (img.width < MIN_IMG_WIDTH || img.height < MIN_IMG_HEIGHT) continue
        result.push({
            page: img.page,
            xMin: img.left,
            xMax: img.left + img.width,
            yMin: img.top,
            yMax: img.top + img.height,
            isImage: true as const,
            image: img,
        })
    }

    result.sort((a, b) => {
        const aPage = a.page; const bPage = b.page
        if (aPage !== bPage) return aPage - bPage
        return a.yMin - b.yMin || a.xMin - b.xMin
    })

    return result.filter(item => {
        if (!("isImage" in item)) return true
        return !!item.isImage
    }) as PdfLine[]
}

interface ImageParagraph {
    page: number
    yMin: number
    yMax: number
    xMin: number
    image: PdfImage
}

function linesToStyledParagraphs(
    lines: PdfLine[],
    images: PdfImage[],
): { paragraphs: StyledParagraph[]; imageParagraphs: ImageParagraph[] } {
    if (lines.length === 0) {
        return { paragraphs: [], imageParagraphs: [] }
    }

    const config = loadConfig()
    const profile = detectBookProfile(lines)
    const baseMetrics = computeMetrics(lines)
    const preparedLines = mergeWrappedCodeDeclarations(
        filterInsetAsideBlocks(filterInlineArtifacts(lines, baseMetrics), baseMetrics),
    )
    const metrics = computeMetrics(preparedLines)

    const paragraphs: StyledParagraph[] = []
    const imageParagraphs: ImageParagraph[] = []

    let proseBuffer: string[] = []
    let codeBuffer: { rawText: string; xMin: number }[] = []
    let tableBuffer: PdfLine[] = []
    let prev: PdfLine | null = null
    let headingStreak = 0

    const flushProse = () => {
        if (proseBuffer.length === 0) return
        const text = joinProseLines(proseBuffer)
        proseBuffer = []
        if (text) paragraphs.push({ type: "paragraph", text })
    }

    const flushCode = () => {
        if (codeBuffer.length === 0) return
        const prepared = codeBuffer.map(line =>
            line.rawText === "" ? "" : normalizeCodeIndent(line.rawText, line.xMin, metrics))

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
        const rows = parseTableRowsFromCluster(tableBuffer)
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

    const flushAll = () => { flushProse(); flushCode(); flushTable() }

    const appendToLastListItem = (text: string) => {
        const last = paragraphs[paragraphs.length - 1]
        if (!last || last.type !== "list-item") return false
        last.text = `${last.text} ${text}`.replace(/\s+/g, " ").trim()
        return true
    }

    for (const line of preparedLines) {
        const text = line.compact
        if (!text) continue

        const verticalGap = !prev ? Number.POSITIVE_INFINITY : line.yMin - prev.yMax

        let effectiveGap = verticalGap
        if (!!prev && line.page !== prev.page) {
            if (line.yMin < metrics.bodyLineHeight * 6) {
                effectiveGap = metrics.bodyLineHeight * 1.0
            } else {
                effectiveGap = Number.POSITIVE_INFINITY
            }
        }

        if (effectiveGap > metrics.bodyLineHeight * 1.9) {
            flushAll()
        }

        // Inject images at page boundaries (Phase 3)
        const pageImages = images.filter(
            img => img.page === line.page && img.top >= (prev?.yMax || 0) && img.top <= line.yMin
        )
        for (const img of pageImages) {
            if (img.width >= 30 && img.height >= 30) {
                imageParagraphs.push({
                    page: img.page,
                    yMin: img.top,
                    yMax: img.top + img.height,
                    xMin: img.left,
                    image: img,
                })
            }
        }

        const heading = detectHeading(line, metrics)
        if (heading.isHeading && !looksLikeCodeLine(line, metrics, profile) && !looksLikeTableBlock([line])) {
            flushAll()

            // False heading suppression (Phase 4): cap heading streaks
            headingStreak++
            const isStrongHeadingPattern = /^(chapter|part|appendix|section|\d+\.)/i.test(text)

            if (headingStreak > 4 && !isStrongHeadingPattern) {
                paragraphs.push({ type: "paragraph", text })
                prev = line
                continue
            }

            paragraphs.push({
                type: "heading",
                text: sanitizeHeadingText(text),
                level: heading.level,
            })
            prev = line
            continue
        }

        headingStreak = 0

        if (/^[-=*_]{3,}\s*$/.test(text)) {
            flushAll()
            paragraphs.push({ type: "separator", text: "" })
            prev = line
            continue
        }

        if (looksLikeCodeLine(line, metrics, profile)) {
            flushProse()
            flushTable()
            if (shouldStartNewCodeBlock(text, metrics, line.xMin, profile) || codeBuffer.length > 0) {
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

        if (looksLikeTableBlock([line])) {
            flushProse()
            tableBuffer.push(line)
            prev = line
            continue
        }

        if (tableBuffer.length > 0) {
            const continuation = verticalGap <= metrics.bodyLineHeight * 1.2 && looksLikeTableBlock([line])
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
            line.xMin > prev.xMin + metrics.bodyLineHeight * 0.45
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

    return {
        paragraphs: paragraphs.filter(p => (p.text || "").trim().length > 0 || p.type === "separator"),
        imageParagraphs,
    }
}

// ═══════════════════════════════════════════════════════════
// Chapter building — outline-based (Phase 2)
// ═══════════════════════════════════════════════════════════

function makeChapter(order: number, title: string, paragraphs: StyledParagraph[]): Chapter {
    return {
        id: `ch-${order}`,
        title: title.trim() || `Chapter ${order + 1}`,
        order,
        paragraphs,
        wordCount: countWords(paragraphs),
    }
}

function buildChaptersFromOutline(
    outlineItems: PdfOutlineItem[],
    lines: PdfLine[],
    paragraphs: StyledParagraph[],
    fallbackTitle: string,
): Chapter[] {
    if (outlineItems.length === 0 || lines.length === 0) {
        return buildChaptersFromParagraphs(paragraphs, fallbackTitle)
    }

    const flat = flattenOutline(outlineItems)
    if (flat.length === 0) return buildChaptersFromParagraphs(paragraphs, fallbackTitle)

    // Map paragraphs to pages for outline-based splitting
    const paraPageMap = new Map<number, StyledParagraph[]>()
    // We need to track which page each paragraph is on
    function assignPagesToParagraphs(paragraphs: StyledParagraph[], lines: PdfLine[]): Map<number, number> {
        // This is approximate — assign paragraph index to page by matching line positions
        const pageMap = new Map<number, number>()
        let paraIdx = 0
        let lastParaIdx = -1
        for (const line of lines) {
            if (paraIdx < paragraphs.length && paraIdx !== lastParaIdx) {
                pageMap.set(paraIdx, line.page)
                lastParaIdx = paraIdx
            }
            paraIdx = Math.min(paragraphs.length - 1, paraIdx)
        }
        return pageMap
    }

    // Build chapters from outline page ranges
    const chapters: Chapter[] = []

    for (let i = 0; i < flat.length; i++) {
        const item = flat[i]!
        const startPage = item.page
        const nextPage = i + 1 < flat.length ? flat[i + 1]!.page : Number.MAX_SAFE_INTEGER

        const chapterParagraphs: StyledParagraph[] = []

        // Collect paragraphs for lines in this page range
        let paraIdx = 0
        for (const line of lines) {
            if (line.page >= startPage && line.page < nextPage) {
                if (paraIdx < paragraphs.length) {
                    chapterParagraphs.push(paragraphs[paraIdx]!)
                    paraIdx++
                }
            } else if (line.page >= nextPage) {
                break
            }
        }

        // Skip empty TOC/copyright-style front matter
        const normalizedTitle = item.title.toLowerCase().trim()
        if (/(table of contents|contents|copyright|title page|imprint)/.test(normalizedTitle) && chapterParagraphs.length < 3) {
            continue
        }

        if (chapterParagraphs.length > 0) {
            chapters.push(makeChapter(chapters.length, item.title, chapterParagraphs))
        }
    }

    // Handle trailing paragraphs after last outline entry
    if (chapters.length === 0) {
        return buildChaptersFromParagraphs(paragraphs, fallbackTitle)
    }

    return chapters
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
                currentTitle = sanitizeHeadingText(text) || `Section ${chapters.length + 1}`
                current = [{ ...p, text: currentTitle || p.text }]
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
            chunked.push(makeChapter(chunked.length, `${source.title} (Part ${chunked.length + 1})`, slice))
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

function shouldSplitAtHeading(text: string, level: number, currentParagraphCount: number): boolean {
    text = sanitizeHeadingText(text)
    if (currentParagraphCount < 10) return false
    if (/^figure\b/i.test(text) || looksLikeDiagramLabel(text)) return false
    if (/^(chapter|part|appendix)\s+\w+/i.test(text)) return true
    if (/\bCRUX\b/i.test(text) && currentParagraphCount >= 24) return true
    if (/^\d+(?:\.\d+)+\s+[A-Z]/.test(text) && currentParagraphCount >= 16) return true
    if (/^\d+\.\s+[A-Z]/.test(text) && currentParagraphCount >= 24) return true
    if (level <= 2 && currentParagraphCount >= 60 && text.split(/\s+/).length >= 3 && text.length >= 18) return true
    return false
}

function chooseChapterTitle(paragraphs: StyledParagraph[], fallbackTitle: string): string {
    const headings = paragraphs
        .filter((p) => p.type === "heading")
        .map((p) => ({
            text: sanitizeHeadingText(p.text.trim()),
            level: p.level || 3,
        }))
        .filter((p) => !!p.text)

    if (headings.length === 0) return fallbackTitle

    let bestScore = -1; let bestText = fallbackTitle

    for (const heading of headings) {
        let score = 0
        if (/^(chapter|part|appendix)\s+\w+/i.test(heading.text)) score = 100
        else if (/^\d+(?:\.\d+)+\s+[A-Z]/.test(heading.text)) score = 95
        else if (/^\d+\.\s+[A-Z]/.test(heading.text)) score = 90
        else if (/^section\s+\d+/i.test(heading.text)) score = 85
        else score = Math.max(0, 40 - heading.level * 4)

        if (score > bestScore) { bestScore = score; bestText = heading.text }
    }

    return bestText || fallbackTitle
}

// ═══════════════════════════════════════════════════════════
// Finalization, filtering, merging
// ═══════════════════════════════════════════════════════════

function mergeBrokenParagraphs(paragraphs: StyledParagraph[]): StyledParagraph[] {
    const merged: StyledParagraph[] = []
    for (const p of paragraphs) {
        const text = (p.text || "").trim()
        const prev = merged[merged.length - 1]
        if (prev && prev.type === "paragraph" && p.type === "paragraph" && text) {
            const prevText = prev.text.trim()
            const startsLower = /^[a-z(]/.test(text)
            const prevHyphen = /[A-Za-z]-$/.test(prevText)
            const prevSoftEnd = /(?:,|;|:|of|to|the|a|an|and|or|for|with|into|onto|from|their|its)$/.test(prevText)
            if (prevHyphen) {
                prev.text = `${prevText.slice(0, -1)}${text}`.replace(/\s+/g, " ").trim()
                continue
            }
            if (startsLower || prevSoftEnd) {
                prev.text = `${prevText} ${text}`.replace(/\s+/g, " ").trim()
                continue
            }
        }
        merged.push({ ...p })
    }
    return merged
}

function finalizeParagraphsForChapters(paragraphs: StyledParagraph[]): StyledParagraph[] {
    const out: StyledParagraph[] = []
    let headingStreak = 0
    let inToc = false
    let tocBudget = 0

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i]!
        const text = (p.text || "").trim()
        if (!text && p.type !== "separator") continue

        // Strip inline emphasis markers from non-paragraph types (Phase 1)
        if (p.type !== "paragraph" && p.type !== "code" && p.type !== "table") {
            p.text = stripEmphasisMarkers(text)
        }

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
            if (/^Figure \d+(?:\.\d+)*:/i.test(text)) continue
        }

        if (p.type === "heading") {
            p.text = sanitizeHeadingText(stripEmphasisMarkers(text))
            if ((text.match(/\./g) || []).length >= 8 && text.replace(/[.\s]/g, "").length < 25) continue
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

            // TOC handling
            if (/^table of contents$/i.test(text)) {
                inToc = true
                tocBudget = 260
                out.push({ type: "heading", text: "Table of Contents", level: 2 })
                headingStreak++
                continue
            }

            // Garbage heading filters
            if (/^\d+$/.test(text) || text.length <= 2 || /^\d{3,}$/.test(text) || /^\d+\s+bytes?$/i.test(text) || /^iv|v?i{1,3}|x{1,3}$/i.test(text) || /^\.{8,}$/.test(text)) continue

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

            headingStreak++

            // Cap heading streak (Phase 4): convert runaway heading storms to paragraphs
            if (headingStreak > 4 && text.length < 40 && !/^(chapter|part|appendix|section|\d+\.)/i.test(text)) {
                out.push({ type: "paragraph", text })
                continue
            }

            out.push(p)
            continue
        }

        headingStreak = 0

        if (p.type === "paragraph") {
            if (/^table of contents\s+/i.test(text)) {
                inToc = true
                tocBudget = Math.max(tocBudget, 200)
            }

            if (inToc && tocBudget > 0) {
                tocBudget--
                if (/^(chapter|section|part|appendix)\s+\w+/i.test(text)) {
                    inToc = false; tocBudget = 0
                } else if (isTocEntry(text)) {
                    const cleaned = text
                        .replace(/^table of contents\s+/i, "").replace(/^\d+\s+/, "")
                        .replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim()
                    if (!cleaned) continue
                    out.push({ type: "list-item", text: cleaned, ordered: false, indent: 0 })
                    continue
                }
            }

            if (/^\d+$/.test(text) || /^[ivxlcdm]+$/i.test(text)) continue
            if (/^\.{8,}$/.test(text)) continue

            if (/^\d+\s+\d+(?:\.\d+)*\.?\s+[A-Za-z]/.test(text)) {
                out.push({
                    type: "list-item",
                    text: text.replace(/^\d+\s+/, "").replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim(),
                    ordered: false,
                    indent: 0,
                })
                continue
            }

            if (isTocEntry(text)) {
                out.push({
                    type: "list-item",
                    text: text.replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim(),
                    ordered: false,
                    indent: 0,
                })
                continue
            }

            if (/^table of contents$/i.test(text)) {
                out.push({ type: "heading", text: "Table of Contents", level: 2 })
                continue
            }

            if (/^[ivxlcdm]+$/i.test(text) && text.length <= 6) continue

            if (/^(table of contents\s+)?\d+(?:\.\d+)*\.?\s+[A-Z].+\.{4,}\s*\d+$/i.test(text)) {
                const cleaned = text.replace(/^table of contents\s+/i, "").replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim()
                if (!cleaned) continue
                out.push({ type: "list-item", text: cleaned, ordered: false, indent: 0 })
                continue
            }

            if (/^[A-Za-z].*\.{4,}\s*(?:\d+|[ivxlcdm]+)$/i.test(text)) {
                const cleaned = text.replace(/\.{4,}\s*(?:\d+|[ivxlcdm]+)\s*$/i, "").trim()
                if (!cleaned) continue
                out.push({ type: "list-item", text: cleaned, ordered: false, indent: 0 })
                continue
            }

            if (/^(chapter|section|part|appendix)\s+\w+/i.test(text)) {
                inToc = false; tocBudget = 0
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

// ═══════════════════════════════════════════════════════════
// Pipeline helpers: filter/misc
// ═══════════════════════════════════════════════════════════

function filterInlineArtifacts(lines: PdfLine[], metrics: PdfMetrics): PdfLine[] {
    return lines.filter(line => {
        if (/^Figure \d+(?:\.\d+)*:/i.test(line.compact)) return false
        return true
    })
}

function filterInsetAsideBlocks(lines: PdfLine[], metrics: PdfMetrics): PdfLine[] {
    const filtered: PdfLine[] = []
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

function mergeWrappedCodeDeclarations(lines: PdfLine[]): PdfLine[] {
    const merged: PdfLine[] = []
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
            continue
        }
        merged.push({ ...line })
    }
    return merged
}

// ═══════════════════════════════════════════════════════════
// Multi-column detection (Phase 5)
// ═══════════════════════════════════════════════════════════

function detectMultiColumn(lines: PdfLine[]): boolean {
    const byPage = new Map<number, PdfLine[]>()
    for (const line of lines) {
        if (!byPage.has(line.page)) byPage.set(line.page, [])
        byPage.get(line.page)!.push(line)
    }

    let columnPageCount = 0
    for (const pageLines of byPage.values()) {
        // Build histogram of x positions
        const xPositions = pageLines
            .filter(l => !isMarginLine(l) && l.compact.length > 20)
            .map(l => l.xMin)

        if (xPositions.length < 10) continue

        // Cluster x positions into groups
        const clusters = clusterValues(xPositions, 30)
        const colClusters = clusters.filter(c => c.length >= 3)
        if (colClusters.length >= 2) columnPageCount++
    }

    return columnPageCount >= 2
}

function clusterValues(values: number[], tolerance: number): number[][] {
    const sorted = values.slice().sort((a, b) => a - b)
    const clusters: number[][] = []
    let current: number[] = []

    for (const v of sorted) {
        if (current.length === 0 || v - current[current.length - 1]! <= tolerance) {
            current.push(v)
        } else {
            if (current.length > 0) clusters.push(current)
            current = [v]
        }
    }
    if (current.length > 0) clusters.push(current)
    return clusters
}

// ═══════════════════════════════════════════════════════════
// Scanned PDF detection (Phase 6)
// ═══════════════════════════════════════════════════════════

function isScannedPdf(lines: PdfLine[]): boolean {
    if (lines.length === 0) return false
    const textContent = lines.map(l => l.compact).join(" ")
    const wordCount = textContent.split(/\s+/).filter(Boolean).length
    // Very few words extracted → likely scanned (image-only, no text layer)
    return wordCount < 50
}

function attemptOcr(filePath: string, outputPath: string): boolean {
    if (!hasOcrSupport()) return false
    try {
        execFileSync("tesseract", [filePath, outputPath, "-l", "eng"], {
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf-8",
            maxBuffer: 64 * 1024 * 1024,
        })
        return true
    } catch {
        try {
            execFileSync("ocrmypdf", [filePath, outputPath], {
                stdio: ["ignore", "pipe", "pipe"],
                encoding: "utf-8",
                maxBuffer: 128 * 1024 * 1024,
            })
            return true
        } catch {
            return false
        }
    }
}

// ═══════════════════════════════════════════════════════════
// Layout fallback (unchanged core)
// ═══════════════════════════════════════════════════════════

function layoutTextToSyntheticLines(text: string): PdfLine[] {
    const pages = text.split("\f")
    const lines: PdfLine[] = []
    for (let pi = 0; pi < pages.length; pi++) {
        const page = pages[pi] || ""
        const rawLines = page.split("\n")
        let y = 72
        for (const raw of rawLines) {
            const normalizedRaw = raw.replace(/\t/g, "    ").replace(/\s+$/g, "")
            const compact = normalizedRaw.trim().replace(/\s+/g, " ")
            if (!compact) { y += 12; continue }
            const leadingSpaces = (normalizedRaw.match(/^\s*/) || [""])[0]!.length
            lines.push({
                page: pi + 1, pageWidth: 612, pageHeight: 792,
                xMin: 72 + leadingSpaces * 4, xMax: 72 + leadingSpaces * 4 + Math.max(1, compact.length) * 6,
                yMin: y, yMax: y + 11, raw: normalizedRaw, compact,
                runs: [], avgFontSize: 10, family: "sans-serif", color: "#000000",
                bold: false, italic: false, href: null, startPage: leadingSpaces < 8,
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
        const { paragraphs } = linesToStyledParagraphs(syntheticLines, [])
        const merged = mergeBrokenParagraphs(finalizeParagraphsForChapters(paragraphs))
        return buildChaptersFromParagraphs(merged, fallbackTitle)
    } catch {
        return []
    }
}

// ═══════════════════════════════════════════════════════════
// Main parse entry point (Phase 0-7)
// ═══════════════════════════════════════════════════════════

export async function parsePdf(filePath: string): Promise<ParsedBook> {
    if (!hasPdfSupport()) {
        throw new Error(
            "pdftohtml not found. Install poppler-utils:\n  sudo apt install poppler-utils",
        )
    }

    const config = loadConfig()
    const info = getPdfInfo(filePath)

    // Check encryption (Phase 5)
    if (info.encrypted) {
        throw new Error(
            "This PDF is encrypted/password-protected. To open it, set TBOOK_PDF_PASSWORD or use the --pdf-password flag."
        )
    }

    const basename = filePath.split("/").pop() || "Untitled"
    const fallbackTitle = basename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ")

    const metadata: BookMetadata = {
        title: cleanPdfInfoValue(info.title) || fallbackTitle,
        author: cleanPdfInfoValue(info.author) || "Unknown",
        description: undefined,
    }

    let chapters: Chapter[] = []
    let totalWords = 0
    let imageMap = new Map<string, string>()
    let coverBuffer: Buffer | undefined

    try {
        const { xml, workDir } = extractPdfToXml(filePath)

        const root = parseHTML(xml, { lowerCaseTagName: true })
        const fontSpecs = parseFontSpecs(root)
        const outline = parseOutline(root)

        const { lines, images } = parseBboxLines(xml, fontSpecs)

        // Scanned PDF detection (Phase 6)
        if (isScannedPdf(lines)) {
            const cacheDir = join(homedir(), ".tbook", "cache", "ocr")
            if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
            const ocrOutput = join(cacheDir, `${createHash("md5").update(filePath).digest("hex")}.txt`)

            if (!existsSync(ocrOutput)) {
                const ok = attemptOcr(filePath, ocrOutput)
                if (!ok) {
                    throw new Error(
                        "This PDF appears to be a scanned document (no text layer detected).\n" +
                        "Install tesseract-ocr for OCR support:\n  sudo apt install tesseract-ocr",
                    )
                }
            }

            const ocrText = require("fs").readFileSync(ocrOutput, "utf-8")
            const { chapters: ocrChapters, imageMap: ocrImageMap } = await parsePdfViaOcr(ocrText, metadata.title, filePath)
            chapters = ocrChapters
            imageMap = ocrImageMap
            totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)
            return { metadata, chapters, totalWords, imageMap }
        }

        const contentLines = dropFrontMatterPages(
            filterRepeatedMarginLines(lines),
            config,
        )

        const { paragraphs, imageParagraphs } = linesToStyledParagraphs(contentLines, images)

        // Process images (Phase 3)
        if (images.length > 0) {
            const cacheDir = getImageCacheDir(filePath)

            // Copy images from workDir to cache
            const cachedImages = copyImagesToCache(workDir, cacheDir)
            for (const [name, path] of cachedImages) {
                imageMap.set(name, path)
                const cleanName = name.replace(/^\.\//, "").replace(/^\/+/, "").split("/").pop() || name
                if (cleanName !== name) imageMap.set(cleanName, path)
            }

            // Inject image paragraphs at correct positions
            for (const imgPara of imageParagraphs) {
                const src = imgPara.image.src
                const cachedPath = findImageInMap(src, cachedImages)
                if (cachedPath) {
                    const alt = "[Figure]"
                    paragraphs.push({
                        type: "image",
                        text: alt,
                        imageSrc: cachedPath,
                        imageAlt: alt,
                    })
                }
            }

            // Set cover from first full-page image (Phase 3)
            const fullPageImages = images.filter(img => img.width > 300 && img.height > 400)
            if (fullPageImages.length > 0) {
                const coverImg = fullPageImages[0]!
                const coverPath = findImageInMap(coverImg.src, cachedImages)
                if (coverPath) {
                    try {
                        coverBuffer = require("fs").readFileSync(coverPath)
                        metadata.cover = coverBuffer
                    } catch { /* skip */ }
                }
            }
        }

        const merged = mergeBrokenParagraphs(finalizeParagraphsForChapters(paragraphs))

        // Chapter building: prefer outline (Phase 2), fallback to heading heuristics
        if (outline.length > 0) {
            chapters = buildChaptersFromOutline(outline, contentLines, merged, metadata.title)
        } else {
            chapters = buildChaptersFromParagraphs(merged, metadata.title)
        }

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

    // Post-process chapters
    if (chapters.length > 1 && chapters[0]!.wordCount < 80) {
        chapters = chapters.slice(1).map((ch, idx) => ({ ...ch, id: `ch-${idx}`, order: idx }))
        totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0)
    }

    if (chapters.length > 1 && /^(contents|table of contents)$/i.test(chapters[0]!.title.trim())) {
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

    // Clean up stale image caches asynchronously (Phase 3)
    cleanStaleImageCache()
    // Fire-and-forget: not awaited

    return {
        metadata,
        chapters,
        totalWords,
        imageMap,
    }
}

function findImageInMap(src: string, map: Map<string, string>): string | undefined {
    const candidates = new Set<string>()
    const cleanSrc = src.replace(/^\.\//, "").replace(/^\//, "").split("#")[0]!.split("?")[0]!
    candidates.add(src.trim())
    candidates.add(cleanSrc)
    candidates.add(cleanSrc.toLowerCase())
    const fileName = cleanSrc.split("/").pop() || ""
    if (fileName) {
        candidates.add(fileName)
        candidates.add(fileName.toLowerCase())
    }
    for (const c of candidates) {
        const result = map.get(c)
        if (result) return result
    }
    for (const [key, path] of map) {
        if (key.endsWith(fileName) || fileName.endsWith(key)) return path
    }
    return undefined
}

async function parsePdfViaOcr(
    ocrText: string,
    fallbackTitle: string,
    filePath: string,
): Promise<{ chapters: Chapter[]; imageMap: Map<string, string> }> {
    const { paragraphs } = linesToStyledParagraphs(layoutTextToSyntheticLines(ocrText), [])
    const merged = mergeBrokenParagraphs(finalizeParagraphsForChapters(paragraphs))
    const chapters = buildChaptersFromParagraphs(merged, fallbackTitle)

    const imageMap = new Map<string, string>()
    // Also capture page images from the original PDF for the OCR'd content
    try {
        const cacheDir = getImageCacheDir(filePath)
        extractPdfToXml(filePath) // This creates image files
        const copiedImages = copyImagesToCache(cacheDir, cacheDir)
        for (const [name, path] of copiedImages) {
            imageMap.set(name, path)
        }
    } catch { /* skip */ }

    return { chapters, imageMap }
}

/**
 * Quick metadata-only parse for import preview (Phase 6)
 */
export async function parsePdfMetadataPreview(filePath: string): Promise<{
    metadata: BookMetadata
    pageCount: number
    estimatedWords: number
}> {
    const info = getPdfInfo(filePath)
    const basename = filePath.split("/").pop() || "Untitled"
    const fallbackTitle = basename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ")

    return {
        metadata: {
            title: cleanPdfInfoValue(info.title) || fallbackTitle,
            author: cleanPdfInfoValue(info.author) || "Unknown",
            description: undefined,
        },
        pageCount: info.pages,
        estimatedWords: info.pages * 300, // rough page-word estimate
    }
}
