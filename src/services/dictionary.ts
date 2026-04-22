// ─────────────────────────────────────────────────────────────
// Dictionary Service — word definition lookup
// ─────────────────────────────────────────────────────────────

export interface DictionaryEntry {
    word: string
    phonetic?: string
    meanings: {
        partOfSpeech: string
        definitions: {
            definition: string
            example?: string
        }[]
    }[]
    source: string
}

/**
 * Look up a word using the free Dictionary API
 * Falls back gracefully if offline
 */
export async function lookupWord(word: string): Promise<DictionaryEntry | null> {
    const clean = word.trim().toLowerCase().replace(/[^a-z'-]/g, "")
    if (!clean || clean.length < 2) return null

    try {
        const response = await fetch(
            `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(clean)}`,
        )

        if (!response.ok) return null

        const data = await response.json() as any[]
        if (!data || data.length === 0) return null

        const entry = data[0]

        return {
            word: entry.word || clean,
            phonetic: entry.phonetic || entry.phonetics?.[0]?.text || "",
            meanings: (entry.meanings || []).map((m: any) => ({
                partOfSpeech: m.partOfSpeech || "unknown",
                definitions: (m.definitions || []).slice(0, 3).map((d: any) => ({
                    definition: d.definition || "",
                    example: d.example || undefined,
                })),
            })),
            source: "dictionaryapi.dev",
        }
    } catch {
        return null
    }
}

/**
 * Format a dictionary entry for terminal display
 */
export function formatDictionaryEntry(entry: DictionaryEntry): string {
    const lines: string[] = []

    lines.push(`📖 ${entry.word}`)
    if (entry.phonetic) {
        lines.push(`   ${entry.phonetic}`)
    }
    lines.push("")

    for (const meaning of entry.meanings) {
        lines.push(`  ${meaning.partOfSpeech}`)
        for (let i = 0; i < meaning.definitions.length; i++) {
            const def = meaning.definitions[i]!
            lines.push(`   ${i + 1}. ${def.definition}`)
            if (def.example) {
                lines.push(`      "${def.example}"`)
            }
        }
        lines.push("")
    }

    lines.push(`  Source: ${entry.source}`)

    return lines.join("\n")
}
