// ─────────────────────────────────────────────────────────────
// SQLite Database Service — bun:sqlite
// ─────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface BookRecord {
    id: number
    title: string
    author: string
    path: string
    format: string
    total_chapters: number
    current_chapter: number
    scroll_position: number
    last_read_at: string | null
    created_at: string
}

export interface BookmarkRecord {
    id: number
    book_id: number
    chapter: number
    scroll_position: number
    label: string
    created_at: string
}

export interface ReadingStatRecord {
    id: number
    book_id: number
    date: string
    words_read: number
    minutes_read: number
}

export interface HighlightRecord {
    id: number
    book_id: number
    chapter: number
    paragraph_index: number
    text: string
    color: string
    note: string
    created_at: string
}

let db: Database

/**
 * Get or create the database connection
 */
export function getDb(): Database {
    if (db) return db

    const dataDir = join(homedir(), ".tbook")
    if (!existsSync(dataDir)) {
        const { mkdirSync } = require("fs")
        mkdirSync(dataDir, { recursive: true })
    }

    const dbPath = join(dataDir, "tbook.db")
    db = new Database(dbPath)

    // Enable WAL mode for performance
    db.run("PRAGMA journal_mode = WAL")

    // Create tables
    db.run(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT DEFAULT 'Unknown',
      path TEXT UNIQUE NOT NULL,
      format TEXT NOT NULL,
      total_chapters INTEGER DEFAULT 0,
      current_chapter INTEGER DEFAULT 0,
      scroll_position INTEGER DEFAULT 0,
      last_read_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

    db.run(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter INTEGER NOT NULL,
      scroll_position INTEGER DEFAULT 0,
      label TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

    db.run(`
    CREATE TABLE IF NOT EXISTS reading_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      words_read INTEGER DEFAULT 0,
      minutes_read INTEGER DEFAULT 0,
      UNIQUE(book_id, date)
    )
  `)

    db.run(`
    CREATE TABLE IF NOT EXISTS highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter INTEGER NOT NULL,
      paragraph_index INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      color TEXT DEFAULT 'yellow',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

    return db
}

// ─────────────────────────────────────────────────────────────
// Book CRUD
// ─────────────────────────────────────────────────────────────

export function getAllBooks(): BookRecord[] {
    const db = getDb()
    return db.query(
        "SELECT * FROM books ORDER BY last_read_at DESC NULLS LAST, created_at DESC"
    ).all() as BookRecord[]
}

export function getBookById(id: number): BookRecord | null {
    const db = getDb()
    return db.query("SELECT * FROM books WHERE id = ?").get(id) as BookRecord | null
}

export function getBookByPath(path: string): BookRecord | null {
    const db = getDb()
    return db.query("SELECT * FROM books WHERE path = ?").get(path) as BookRecord | null
}

export function insertBook(book: {
    title: string
    author?: string
    path: string
    format: string
    total_chapters?: number
}): BookRecord {
    const db = getDb()
    const stmt = db.query(`
    INSERT OR IGNORE INTO books (title, author, path, format, total_chapters)
    VALUES ($title, $author, $path, $format, $total_chapters)
  `)
    stmt.run({
        $title: book.title,
        $author: book.author || "Unknown",
        $path: book.path,
        $format: book.format,
        $total_chapters: book.total_chapters || 0,
    })
    return getBookByPath(book.path)!
}

export function updateReadingProgress(
    bookId: number,
    chapter: number,
    scrollPosition: number,
): void {
    const db = getDb()
    db.run(
        `UPDATE books
     SET current_chapter = ?, scroll_position = ?, last_read_at = datetime('now')
     WHERE id = ?`,
        [chapter, scrollPosition, bookId],
    )
}

export function deleteBook(id: number): void {
    const db = getDb()
    db.run("DELETE FROM books WHERE id = ?", [id])
}

// ─────────────────────────────────────────────────────────────
// Bookmarks
// ─────────────────────────────────────────────────────────────

export function getBookmarks(bookId: number): BookmarkRecord[] {
    const db = getDb()
    return db.query(
        "SELECT * FROM bookmarks WHERE book_id = ? ORDER BY chapter, scroll_position"
    ).all(bookId) as BookmarkRecord[]
}

export function addBookmark(bookId: number, chapter: number, scrollPos: number, label: string): void {
    const db = getDb()
    db.run(
        "INSERT INTO bookmarks (book_id, chapter, scroll_position, label) VALUES (?, ?, ?, ?)",
        [bookId, chapter, scrollPos, label],
    )
}

export function removeBookmark(id: number): void {
    const db = getDb()
    db.run("DELETE FROM bookmarks WHERE id = ?", [id])
}

// ─────────────────────────────────────────────────────────────
// Reading Stats
// ─────────────────────────────────────────────────────────────

export function recordReading(bookId: number, wordsRead: number, minutesRead: number): void {
    const db = getDb()
    const today = new Date().toISOString().slice(0, 10)
    db.run(
        `INSERT INTO reading_stats (book_id, date, words_read, minutes_read)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id, date) DO UPDATE SET
       words_read = words_read + excluded.words_read,
       minutes_read = minutes_read + excluded.minutes_read`,
        [bookId, today, wordsRead, minutesRead],
    )
}

export function getWeeklyStats(): ReadingStatRecord[] {
    const db = getDb()
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    return db.query(
        `SELECT date, SUM(words_read) as words_read, SUM(minutes_read) as minutes_read
     FROM reading_stats
     WHERE date >= ?
     GROUP BY date
     ORDER BY date ASC`
    ).all(sevenDaysAgo) as ReadingStatRecord[]
}

export function getTotalStats(): { books_read: number; total_words: number; streak: number } {
    const db = getDb()
    const booksRead = (db.query(
        "SELECT COUNT(*) as count FROM books WHERE current_chapter > 0"
    ).get() as any)?.count || 0

    const totalWords = (db.query(
        "SELECT SUM(words_read) as total FROM reading_stats"
    ).get() as any)?.total || 0

    // Calculate streak
    let streak = 0
    const stats = db.query(
        "SELECT DISTINCT date FROM reading_stats ORDER BY date DESC"
    ).all() as { date: string }[]

    if (stats.length > 0) {
        const today = new Date().toISOString().slice(0, 10)
        let checkDate = today
        for (const stat of stats) {
            if (stat.date === checkDate) {
                streak++
                // Go back one day
                const d = new Date(checkDate)
                d.setDate(d.getDate() - 1)
                checkDate = d.toISOString().slice(0, 10)
            } else {
                break
            }
        }
    }

    return { books_read: booksRead, total_words: totalWords, streak }
}

// ─────────────────────────────────────────────────────────────
// Highlights
// ─────────────────────────────────────────────────────────────

export function getHighlights(bookId: number): HighlightRecord[] {
    const db = getDb()
    return db.query(
        "SELECT * FROM highlights WHERE book_id = ? ORDER BY chapter, paragraph_index, created_at"
    ).all(bookId) as HighlightRecord[]
}

export function getChapterHighlights(bookId: number, chapter: number): HighlightRecord[] {
    const db = getDb()
    return db.query(
        "SELECT * FROM highlights WHERE book_id = ? AND chapter = ? ORDER BY paragraph_index"
    ).all(bookId, chapter) as HighlightRecord[]
}

export function addHighlight(bookId: number, chapter: number, paragraphIndex: number, text: string, color: string = "yellow", note: string = ""): void {
    const db = getDb()
    db.run(
        "INSERT INTO highlights (book_id, chapter, paragraph_index, text, color, note) VALUES (?, ?, ?, ?, ?, ?)",
        [bookId, chapter, paragraphIndex, text, color, note],
    )
}

export function removeHighlight(id: number): void {
    const db = getDb()
    db.run("DELETE FROM highlights WHERE id = ?", [id])
}
