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
