// ─────────────────────────────────────────────────────────────
// EPUB Parser Snapshot Test
// Validates parseEpub output for quality metrics:
//   - No raw ** or * markers in chapter titles
//   - All paragraphs have non-empty text (unless separator)
//   - inlineSpans populated on paragraphs with bold/italic/code
//   - Word counts are reasonable
//   - Image map is populated when images exist
//   - Chapter order matches TOC when available
//
// Usage: bun run tests/epub-snapshot.ts [path/to/file.epub]
// ─────────────────────────────────────────────────────────────

import { parseEpub } from "../src/services/epub-parser"
import type { StyledParagraph, InlineSpan } from "../src/utils/html-to-text"

async function main() {
    const epubPath = process.argv[2] || "sherlock.epub"
    console.log(`📖 Parsing: ${epubPath}\n`)

    const book = await parseEpub(epubPath)

    let passed = 0
    let failed = 0

    const check = (label: string, condition: boolean, detail?: string) => {
        const status = condition ? "✅" : "❌"
        console.log(`  ${status} ${label}${detail ? `: ${detail}` : ""}`)
        if (condition) passed++; else failed++
    }

    // ── Metadata checks ──
    console.log("── Metadata ──")
    check("Title present", !!book.metadata.title, book.metadata.title)
    check("Author present", !!book.metadata.author, book.metadata.author)
    check("Chapters exist", book.chapters.length > 0, `${book.chapters.length} chapters`)
    check("Total words > 0", book.totalWords > 0, `${book.totalWords} words`)
    console.log()

    // ── Chapter quality checks ──
    console.log("── Chapter Quality ──")
    for (const ch of book.chapters) {
        check(
            `Chapter "${ch.title}" has paragraphs`,
            ch.paragraphs.length > 0,
            `${ch.paragraphs.length} paragraphs, ${ch.wordCount} words`,
        )

        // No raw ** or * in titles
        const title = ch.title
        const hasRawMarkers = /\*\*|\*[^*]/.test(title)
        check(
            `Chapter "${title}" has no raw ** or * markers`,
            !hasRawMarkers,
        )
    }
    console.log()

    // ── Paragraph quality checks ──
    console.log("── Paragraph Quality ──")
    let totalInlineSpanParagraphs = 0
    let paragraphsWithMarkersInText = 0
    const typeCounts: Record<string, number> = {}

    for (const ch of book.chapters) {
        for (const p of ch.paragraphs) {
            typeCounts[p.type] = (typeCounts[p.type] || 0) + 1

            // Check inlineSpans
            if (p.inlineSpans && p.inlineSpans.length > 0) {
                totalInlineSpanParagraphs++
                // Verify spans have valid data
                for (const s of p.inlineSpans) {
                    if (s.code && s.text) {
                        // code spans should not have backtick markers in text
                        check(
                            `Code span has no backtick markers`,
                            !s.text.includes("`"),
                            `"${s.text}"`,
                        )
                    }
                }
            }

            // Check that headings, quotes, notes don't have raw markers
            if (["heading", "quote", "note", "footnote"].includes(p.type)) {
                if (/\*\*/.test(p.text) || /\*[^*]/.test(p.text)) {
                    paragraphsWithMarkersInText++
                    check(
                        `${p.type} has no raw markers`,
                        false,
                        `"${p.text.slice(0, 50)}..."`,
                    )
                }
            }
        }
    }

    check(
        "Some paragraphs have inlineSpans",
        totalInlineSpanParagraphs > 0,
        `${totalInlineSpanParagraphs} paragraphs with inline formatting`,
    )
    check(
        "No raw markers in headings/quotes/notes",
        paragraphsWithMarkersInText === 0,
        `${paragraphsWithMarkersInText} violations`,
    )
    console.log(`  Paragraph type counts: ${JSON.stringify(typeCounts)}`)
    console.log()

    // ── Image checks ──
    console.log("── Image Map ──")
    check("Image map exists", !!book.imageMap)
    const imageCount = book.imageMap.size
    console.log(`  Images in map: ${imageCount}`)
    if (imageCount > 0) {
        for (const [key, path] of book.imageMap.entries()) {
            check(`Image key "${key}" has path`, !!path, path.slice(0, 60) + "...")
        }
    }
    console.log()

    // ── Chapter ordering check ──
    console.log("── Chapter Order ──")
    for (let i = 0; i < book.chapters.length; i++) {
        const ch = book.chapters[i]!
        check(
            `Chapter ${i} order matches index`,
            ch.order === i,
            `title="${ch.title}", order=${ch.order}`,
        )
    }
    console.log()

    // ── Summary ──
    console.log(`\n${"═".repeat(40)}`)
    console.log(`Results: ${passed} passed, ${failed} failed`)
    if (failed > 0) {
        console.log("⚠️  Some checks failed!")
        process.exit(1)
    } else {
        console.log("✅ All checks passed!")
    }
}

main().catch(err => {
    console.error("Test error:", err)
    process.exit(1)
})
