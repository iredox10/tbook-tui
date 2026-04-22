// ─────────────────────────────────────────────────────────────
// TBook — Tokyo Night Book Color System (Dark + Light)
// ─────────────────────────────────────────────────────────────

export interface ThemeColors {
  bg: { void: string; surface: string; card: string; hover: string; active: string }
  text: { body: string; muted: string; subtle: string; bright: string }
  accent: { blue: string; cyan: string; purple: string; pink: string; green: string; amber: string; orange: string }
  border: { normal: string; focused: string; active: string }
  scrollbar: { track: string; thumb: string }
}

const darkTheme: ThemeColors = {
  bg: {
    void: "#16161e",
    surface: "#1a1b26",
    card: "#1f2335",
    hover: "#292e42",
    active: "#33467c",
  },
  text: {
    body: "#c0caf5",
    muted: "#565f89",
    subtle: "#3b4261",
    bright: "#c8d3f5",
  },
  accent: {
    blue: "#7aa2f7",
    cyan: "#7dcfff",
    purple: "#bb9af7",
    pink: "#f7768e",
    green: "#9ece6a",
    amber: "#e0af68",
    orange: "#ff9e64",
  },
  border: {
    normal: "#3b4261",
    focused: "#7aa2f7",
    active: "#bb9af7",
  },
  scrollbar: {
    track: "#1a1b26",
    thumb: "#7aa2f7",
  },
}

const lightTheme: ThemeColors = {
  bg: {
    void: "#f0ede6",  // warm paper
    surface: "#e8e4dc",
    card: "#ddd9d0",
    hover: "#d0cbc2",
    active: "#b8b3aa",
  },
  text: {
    body: "#3b3228",  // dark brown
    muted: "#7a746a",
    subtle: "#a19b92",
    bright: "#1a1510",
  },
  accent: {
    blue: "#34548a",
    cyan: "#0f6b8a",
    purple: "#7847bd",
    pink: "#c0392b",
    green: "#486b00",
    amber: "#a86c00",
    orange: "#b85c00",
  },
  border: {
    normal: "#c5bfb6",
    focused: "#34548a",
    active: "#7847bd",
  },
  scrollbar: {
    track: "#e8e4dc",
    thumb: "#34548a",
  },
}

// ─────────────────────────────────────────────────────────────
// Active theme management
// ─────────────────────────────────────────────────────────────

let _activeTheme: "dark" | "light" = "dark"

export function setActiveTheme(mode: "dark" | "light") {
  _activeTheme = mode
}

export function getActiveTheme(): "dark" | "light" {
  return _activeTheme
}

/** Get the currently active theme colors */
export function getTheme(): ThemeColors {
  return _activeTheme === "dark" ? darkTheme : lightTheme
}

// Default export — uses dark theme. For dynamic access use getTheme()
export const theme = darkTheme

// ─────────────────────────────────────────────────────────────
// Unicode helpers
// ─────────────────────────────────────────────────────────────

/**
 * Create a Unicode block progress bar
 */
export function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

/**
 * Get progress color based on percentage (blue→purple→green)
 */
export function progressColor(percent: number): string {
  const t = getTheme()
  if (percent < 33) return t.accent.blue
  if (percent < 66) return t.accent.purple
  if (percent >= 100) return t.accent.green
  return t.accent.pink
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "…"
}

/**
 * Format a relative time string
 */
export function relativeTime(date: string | null): string {
  if (!date) return "Never"
  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return `${Math.floor(diffDays / 30)}mo ago`
}

/**
 * Format duration in minutes to a friendly string
 */
export function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

/**
 * Braille spinner frames
 */
export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
