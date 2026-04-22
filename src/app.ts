// ─────────────────────────────────────────────────────────────
// App Shell — view routing and lifecycle management
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
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
    private inputHandlers: ((seq: string) => boolean)[] = []

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
     * Clean up current view before switching
     */
    private clearCurrentView() {
        if (this.currentView) {
            this.currentView.destroy()
            this.currentView = null
            this.currentViewName = null
        }
    }

    showSplash() {
        this.clearCurrentView()
        const view = new SplashView(this.renderer, this)
        view.render()
        this.currentView = view
        this.currentViewName = "splash"
    }

    showLibrary() {
        this.clearCurrentView()
        const view = new LibraryView(this.renderer, this)
        view.render()
        this.currentView = view
        this.currentViewName = "library"
    }

    async openReader(bookId: number) {
        this.clearCurrentView()
        const view = new ReaderView(this.renderer, this)
        await view.render(bookId)
        this.currentView = view
        this.currentViewName = "reader"
    }

    showImport() {
        this.clearCurrentView()
        const view = new ImportView(this.renderer, this)
        view.render()
        this.currentView = view
        this.currentViewName = "import"
    }

    showStats() {
        this.clearCurrentView()
        const view = new StatsView(this.renderer, this)
        view.render()
        this.currentView = view
        this.currentViewName = "stats"
    }

    quit() {
        this.clearCurrentView()
        this.renderer.destroy()
        process.exit(0)
    }
}
