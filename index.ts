// ─────────────────────────────────────────────────────────────
// TBook — Terminal Book Reader
// Entry point
// ─────────────────────────────────────────────────────────────

import { createCliRenderer } from "@opentui/core"
import { App } from "./src/app"
import { getDb } from "./src/services/database"

async function main() {
    // Initialize database
    getDb()

    // Create renderer with optimal settings for a book reader
    const renderer = await createCliRenderer({
        exitOnCtrlC: true,
        targetFps: 30,
        useMouse: true,
        backgroundColor: "#16161e",
    })

    // Create and start the app
    const app = new App(renderer)
    app.start()
}

main().catch((err) => {
    console.error("Fatal error:", err)
    process.exit(1)
})