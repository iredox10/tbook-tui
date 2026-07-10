// ─────────────────────────────────────────────────────────────
// Dictionary Service — word definition lookup
// Online API first, then vocabulary DB cache, then offline fallback
// ─────────────────────────────────────────────────────────────

import { getCachedDefinition, addToVocabulary } from "./database"
import { lookupOffline } from "../data/offline-dictionary"

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
 * Look up a word using the free Dictionary API.
 * Falls back to DB cache, then offline dictionary.
 */
export async function lookupWord(word: string): Promise<DictionaryEntry | null> {
    const clean = word.trim().toLowerCase().replace(/[^a-z'-]/g, "")
    if (!clean || clean.length < 2) return null

    // 1. Try online API
    try {
        const response = await fetch(
            `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(clean)}`,
        )

        if (response.ok) {
            const data = await response.json() as any[]
            if (data && data.length > 0) {
                const entry = data[0]
                const result: DictionaryEntry = {
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

                // Cache for offline reuse
                const defSummary = result.meanings.map(m =>
                    `${m.partOfSpeech}: ${m.definitions.map(d => d.definition).join("; ")}`
                ).join(" | ")
                addToVocabulary(clean, defSummary, result)

                return result
            }
        }
    } catch {
        // Network error — continue to fallbacks
    }

    // 2. Check vocabulary DB cache (previously looked up online)
    const cached = getCachedDefinition(clean)
    if (cached && cached.word) {
        return cached as DictionaryEntry
    }

    // 3. Fall back to offline dictionary
    const offlineText = lookupOffline(clean)
    if (offlineText) {
        return {
            word: clean,
            meanings: [{
                partOfSpeech: "unknown",
                definitions: [{ definition: offlineText }],
            }],
            source: "offline dictionary",
        }
    }

    return null
}

/**
 * Format a dictionary entry for terminal display
 */
export function formatDictionaryEntry(entry: DictionaryEntry): string {
    const lines: string[] = []

    lines.push(`\uD83D\uDCD6 ${entry.word}`)
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
