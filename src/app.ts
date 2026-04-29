// ─────────────────────────────────────────────────────────────
// App Shell — view routing and lifecycle management
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import { BoxRenderable } from "@opentui/core"
import { SplashView } from "./views/splash"
import { LibraryView } from "./views/library"
import { ReaderView } from "./views/reader"
import { ImportView } from "./views/import"
import { StatsView } from "./views/stats"

type ViewName = "splash" | "library" | "reader" | "import" | "stats"

interface ViewInstance {
    destroy(): void
}

export class App {
    private renderer: CliRenderer
    private currentView: ViewInstance | null = null
    private currentViewName: ViewName | null = null
    private transitionBox: any = null

    constructor(renderer: CliRenderer) {
        this.renderer = renderer
    }

    /**
     * Start the app — show splash screen
     */
    start() {
        this.showSplash()
    }

    /**
     * Clean up current view before switching with a brief fade transition
     */
    private async transitionTo(callback: () => void | Promise<void>) {
        // Create transition overlay
        const overlay = new BoxRenderable(this.renderer, {
            id: "transition-overlay",
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundColor: "#16161e",
            zIndex: 100,
        })

        // Fade in
        overlay.opacity = 0
        this.renderer.root.add(overlay)

        let frame = 0
        await new Promise<void>(resolve => {
            const interval = setInterval(() => {
                frame++
                overlay.opacity = Math.min(1, frame * 0.25)
                if (overlay.opacity >= 1) {
                    clearInterval(interval)
                    resolve()
                }
            }, 30)
        })

        // Swap view
        if (this.currentView) {
            this.currentView.destroy()
            this.currentView = null
            this.currentViewName = null
        }

        await callback()

        // Fade out
        frame = 0
        await new Promise<void>(resolve => {
            const interval = setInterval(() => {
                frame++
                overlay.opacity = Math.max(0, 1 - frame * 0.25)
                if (overlay.opacity <= 0) {
                    clearInterval(interval)
                    try { this.renderer.root.remove(overlay.id) } catch { }
                    resolve()
                }
            }, 30)
        })
    }

    private clearCurrentView() {
        if (this.currentView) {
            this.currentView.destroy()
            this.currentView = null
            this.currentViewName = null
        }
    }

    showSplash() {
        this.transitionTo(() => {
            const view = new SplashView(this.renderer, this)
            view.render()
            this.currentView = view
            this.currentViewName = "splash"
        })
    }

    showLibrary() {
        this.transitionTo(() => {
            const view = new LibraryView(this.renderer, this)
            view.render()
            this.currentView = view
            this.currentViewName = "library"
        })
    }

    async openReader(bookId: number) {
        await this.transitionTo(async () => {
            const view = new ReaderView(this.renderer, this)
            await view.render(bookId)
            this.currentView = view
            this.currentViewName = "reader"
        })
    }

    showImport() {
        this.transitionTo(() => {
            const view = new ImportView(this.renderer, this)
            view.render()
            this.currentView = view
            this.currentViewName = "import"
        })
    }

    showStats() {
        this.transitionTo(() => {
            const view = new StatsView(this.renderer, this)
            view.render()
            this.currentView = view
            this.currentViewName = "stats"
        })
    }

    quit() {
        this.clearCurrentView()
        this.renderer.destroy()
        process.exit(0)
    }
}
