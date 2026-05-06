// ─────────────────────────────────────────────────────────────
// Deep Link Service — paragraph-level linking
// Format: tbook://book-id/chapter/paragraph
// ─────────────────────────────────────────────────────────────

export interface DeepLink {
    bookId: number
    chapter: number
    paragraph?: number
}

/**
 * Generate a deep link string for a specific position in a book
 */
export function generateDeepLink(
    bookId: number,
    chapter: number,
    paragraph?: number,
): string {
    const parts = [`tbook://${bookId}/${chapter}`]
    if (paragraph !== undefined) {
        parts[0] += `/${paragraph}`
    }
    return parts[0]!
}

/**
 * Parse a deep link string into its components
 */
export function parseDeepLink(link: string): DeepLink | null {
    // Support both tbook://id/ch/para and tbook:id:ch:para formats
    let match = link.match(/^tbook:\/\/(\d+)\/(\d+)(?:\/(\d+))?$/)
    if (!match) {
        match = link.match(/^tbook:(\d+):(\d+)(?::(\d+))?$/)
    }
    if (!match) return null

    return {
        bookId: parseInt(match[1]!, 10),
        chapter: parseInt(match[2]!, 10),
        paragraph: match[3] ? parseInt(match[3], 10) : undefined,
    }
}

/**
 * Generate a human-readable position string
 */
export function formatPosition(
    bookTitle: string,
    chapter: number,
    totalChapters: number,
    paragraph?: number,
): string {
    const chStr = `Ch.${chapter + 1}/${totalChapters}`
    const paraStr = paragraph !== undefined ? `, ¶${paragraph + 1}` : ""
    return `📖 ${bookTitle} — ${chStr}${paraStr}`
}

/**
 * Copy a deep link to clipboard (cross-platform)
 */
export async function copyDeepLinkToClipboard(link: string): Promise<boolean> {
    try {
        const { execSync } = require("child_process")
        const platform = process.platform

        if (platform === "darwin") {
            execSync(`echo -n "${link}" | pbcopy`)
        } else if (platform === "linux") {
            // Try xclip first, then xsel, then wl-copy (Wayland)
            try {
                execSync(`echo -n "${link}" | xclip -selection clipboard`)
            } catch {
                try {
                    execSync(`echo -n "${link}" | xsel --clipboard --input`)
                } catch {
                    execSync(`echo -n "${link}" | wl-copy`)
                }
            }
        } else if (platform === "win32") {
            execSync(`echo ${link} | clip`)
        }
        return true
    } catch {
        return false
    }
}
