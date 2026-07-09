// ─────────────────────────────────────────────────────────────
// Config Service — TOML-based user configuration
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface TBookConfig {
    theme: "dark" | "light"
    defaultZoom: number        // zoom index 0-7
    autoScrollSpeed: number    // speed index 0-3
    importPaths: string[]      // quick-access directories
    exportDir: string          // where to save markdown exports
    exportFormat: "obsidian" | "logseq"
    sidebarVisible: boolean    // show chapter sidebar by default
    mouseEnabled: boolean      // enable mouse scroll
    scanDepth: number          // max directory depth for import scan (1-8)
    recentScanPaths: string[]  // last N scanned directories
    lineSpacing: number        // 0=compact, 1=normal, 2=loose
    aiProvider: "ollama" | "openai"
    aiModel: string
    aiApiKey: string
    aiBaseUrl: string
    // Reading goals
    readingGoal: {
        dailyWords: number     // 0 = disabled
        dailyMinutes: number   // 0 = disabled
    }
    // Custom keybinds (key = action, value = key sequence)
    customKeybinds: Record<string, string>
    // PDF-specific options
    pdf: {
        showFrontMatter: boolean  // show preface/TOC/copyright pages (default false)
        showPageSeparators: boolean // show page boundary markers
        pdfPassword: string       // password for encrypted PDFs
    }
}

const CONFIG_PATH = join(homedir(), ".tbook", "config.json")

const DEFAULT_CONFIG: TBookConfig = {
    theme: "dark",
    defaultZoom: 3,
    autoScrollSpeed: 1,
    importPaths: [
        homedir(),
        join(homedir(), "Documents"),
        join(homedir(), "Downloads"),
    ],
    exportDir: join(homedir(), "Documents", "TBook Export"),
    exportFormat: "obsidian",
    sidebarVisible: true,
    mouseEnabled: true,
    scanDepth: 3,
    recentScanPaths: [],
    lineSpacing: 1,
    aiProvider: "ollama",
    aiModel: "llama3",
    aiApiKey: "",
    aiBaseUrl: "http://localhost:11434",
    readingGoal: {
        dailyWords: 0,
        dailyMinutes: 0,
    },
    customKeybinds: {},
    pdf: {
        showFrontMatter: false,
        showPageSeparators: false,
        pdfPassword: "",
    },
}

let cachedConfig: TBookConfig | null = null

/**
 * Load config from disk, or create default
 */
export function loadConfig(): TBookConfig {
    if (cachedConfig) return cachedConfig

    try {
        if (existsSync(CONFIG_PATH)) {
            const raw = readFileSync(CONFIG_PATH, "utf-8")
            const parsed = JSON.parse(raw)
            cachedConfig = { ...DEFAULT_CONFIG, ...parsed }
        } else {
            cachedConfig = { ...DEFAULT_CONFIG }
            saveConfig(cachedConfig)
        }
    } catch {
        cachedConfig = { ...DEFAULT_CONFIG }
    }

    return cachedConfig!
}

/**
 * Save config to disk
 */
export function saveConfig(config: TBookConfig): void {
    cachedConfig = config
    const dir = join(homedir(), ".tbook")
    if (!existsSync(dir)) {
        const { mkdirSync } = require("fs")
        mkdirSync(dir, { recursive: true })
    }

    try {
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8")
    } catch {
        // Silently fail on config write errors
    }
}

/**
 * Update a single config key
 */
export function updateConfig<K extends keyof TBookConfig>(
    key: K,
    value: TBookConfig[K],
): void {
    const config = loadConfig()
    config[key] = value
    saveConfig(config)
}

/**
 * Get a single config value
 */
export function getConfigValue<K extends keyof TBookConfig>(key: K): TBookConfig[K] {
    return loadConfig()[key]
}

/**
 * Reset config to defaults
 */
export function resetConfig(): void {
    cachedConfig = { ...DEFAULT_CONFIG }
    saveConfig(cachedConfig)
}

/**
 * Get config file path (for display)
 */
export function getConfigPath(): string {
    return CONFIG_PATH
}
