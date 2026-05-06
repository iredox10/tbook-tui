// ─────────────────────────────────────────────────────────────
// Terminal Image Renderer — renders images via Kitty/Sixel/iTerm2
// ─────────────────────────────────────────────────────────────

import { execSync } from "child_process"

export type ImageProtocol = "kitty" | "sixel" | "iterm2" | "none"

/**
 * Detect which terminal image protocol is supported
 */
export function detectImageProtocol(): ImageProtocol {
    const term = process.env.TERM || ""
    const termProgram = process.env.TERM_PROGRAM || ""
    const kittyPid = process.env.KITTY_PID || ""

    // Kitty terminal
    if (kittyPid || termProgram === "kitty") return "kitty"

    // iTerm2
    if (termProgram === "iTerm.app" || process.env.LC_TERMINAL === "iTerm2") return "iterm2"

    // WezTerm (supports both kitty and sixel)
    if (termProgram === "WezTerm") return "kitty"

    // Sixel support — check if terminal supports it
    if (term.includes("xterm") || termProgram === "mlterm" || termProgram === "foot") {
        return "sixel"
    }

    return "none"
}

/**
 * Render an image buffer to the terminal using the appropriate protocol.
 * Returns the ANSI escape sequence string to output.
 */
export function renderImageToTerminal(
    imageData: Buffer,
    options: { width?: number; height?: number } = {},
): string {
    const protocol = detectImageProtocol()

    switch (protocol) {
        case "kitty":
            return renderKitty(imageData, options)
        case "iterm2":
            return renderITerm2(imageData, options)
        case "sixel":
            return renderSixel(imageData)
        default:
            return "[Image: terminal does not support image rendering]"
    }
}

/**
 * Kitty Graphics Protocol
 * https://sw.kovidgoyal.net/kitty/graphics-protocol/
 */
function renderKitty(
    imageData: Buffer,
    options: { width?: number; height?: number },
): string {
    const b64 = imageData.toString("base64")
    const chunks: string[] = []
    const chunkSize = 4096

    for (let i = 0; i < b64.length; i += chunkSize) {
        const chunk = b64.slice(i, i + chunkSize)
        const isLast = i + chunkSize >= b64.length
        if (i === 0) {
            // First chunk: include metadata
            const w = options.width ? `,c=${options.width}` : ""
            const h = options.height ? `,r=${options.height}` : ""
            chunks.push(`\x1b_Ga=T,f=100,m=${isLast ? 0 : 1}${w}${h};${chunk}\x1b\\`)
        } else {
            chunks.push(`\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`)
        }
    }

    return chunks.join("")
}

/**
 * iTerm2 Inline Images Protocol
 * https://iterm2.com/documentation-images.html
 */
function renderITerm2(
    imageData: Buffer,
    options: { width?: number; height?: number },
): string {
    const b64 = imageData.toString("base64")
    const w = options.width ? `width=${options.width}` : "width=auto"
    const h = options.height ? `height=${options.height}` : "height=auto"
    return `\x1b]1337;File=inline=1;${w};${h}:${b64}\x07`
}

/**
 * Sixel rendering — requires an external converter
 * Falls back to a placeholder if img2sixel is not available
 */
function renderSixel(imageData: Buffer): string {
    try {
        const result = execSync("img2sixel -", {
            input: imageData,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5000,
        })
        return result.toString()
    } catch {
        return "[Image: install img2sixel (libsixel) for image rendering]"
    }
}

/**
 * Check if terminal supports image rendering
 */
export function supportsImages(): boolean {
    return detectImageProtocol() !== "none"
}
