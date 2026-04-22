# 📖 TBook TUI

A premium **Terminal Book Reader** built with [OpenTUI](https://opentui.com) — read EPUB & PDF books in your terminal with a modern, visually stunning interface.

![TBook](https://img.shields.io/badge/TUI-Book%20Reader-7aa2f7?style=for-the-badge)
![Bun](https://img.shields.io/badge/Bun-Runtime-f5c542?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=for-the-badge)

## ✨ Features

### 📚 Core Reading
- **EPUB & PDF Support** — Full chapter parsing with styled headings, quotes, and paragraphs
- **Library Management** — SQLite-backed book library with search and sorting
- **Reading Progress** — Automatic save/resume with per-book chapter tracking
- **Vim Keybinds** — `j/k` scroll, `h/l` chapters, `space` page-down, `g/G` jump

### 🎨 Premium UI
- **Tokyo Night Design** — Dark & Light theme with `T` toggle
- **ASCII Art Splash** — Stunning first-impression branding
- **Gradient Progress Bars** — Color-coded completion tracking
- **Toast Notifications** — Auto-dismissing feedback overlays

### 🔥 Power Features
- **Text Zoom** — `+`/`-` to adjust reading width (8 zoom levels)
- **Auto-Scroll** — `a` to toggle, `A` to cycle speed (Slow/Normal/Fast/Rapid)
- **Full-Text Search** — `/` to search within the current book with context snippets
- **Chapter TOC Modal** — `t` to jump to any chapter with word counts
- **Bookmarks** — `b` to save, `B` to view/jump-to/delete bookmarks
- **Help Overlay** — `?` for complete keybind reference
- **Book Deletion** — `d` to remove books from library

### 📊 Statistics
- **Reading Stats Dashboard** — Daily word count bar charts
- **Session Tracking** — Words read + minutes recorded per session
- **Streak Counter** — Daily reading streak tracking

## 🚀 Quick Start

```bash
# Prerequisites: Bun + Zig
bun install
bun start
```

For PDF support, install `poppler-utils`:
```bash
# Ubuntu/Debian
sudo apt install poppler-utils

# macOS
brew install poppler
```

## 🎮 Controls

### Reader
| Key | Action |
|-----|--------|
| `j` / `k` / `↑` / `↓` | Scroll up/down |
| `Space` | Page down |
| `g` / `G` | Jump to top / bottom |
| `h` / `l` / `←` / `→` | Previous / next chapter |
| `+` / `-` | Zoom text wider / narrower |
| `a` | Toggle auto-scroll |
| `A` | Cycle auto-scroll speed |
| `T` | Toggle dark / light theme |
| `t` | Chapter list (TOC modal) |
| `/` | Search in book |
| `b` | Add bookmark |
| `B` | View bookmarks |
| `Tab` | Toggle chapter sidebar |
| `?` | Help overlay |
| `q` | Back to library |

### Library
| Key | Action |
|-----|--------|
| `j` / `k` / `↑` / `↓` | Navigate books |
| `Enter` | Open selected book |
| `/` | Search library |
| `n` | Import new books |
| `i` | Reading statistics |
| `d` | Delete selected book |
| `?` | Help overlay |
| `q` | Back to splash |

## 📁 Architecture

```
src/
├── app.ts                  # View routing & lifecycle
├── views/
│   ├── splash.ts           # ASCII art welcome screen
│   ├── library.ts          # Book grid with progress cards
│   ├── reader.ts           # Main reading experience
│   ├── import.ts           # File scanner & importer (EPUB + PDF)
│   └── stats.ts            # Reading statistics dashboard
├── components/
│   ├── status-bar.ts       # Bottom bar with progress & keybinds
│   ├── toast.ts            # Auto-dismissing notifications
│   ├── help-overlay.ts     # Full keybind reference modal
│   ├── chapter-toc.ts      # Chapter navigation modal
│   ├── search-modal.ts     # Full-text search with results
│   └── bookmarks-panel.ts  # Bookmark viewer & manager
├── services/
│   ├── database.ts         # SQLite via bun:sqlite
│   ├── epub-parser.ts      # EPUB → structured chapters
│   └── pdf-parser.ts       # PDF → chapters via pdftotext
└── utils/
    ├── theme.ts            # Tokyo Night Book dual-theme system
    └── html-to-text.ts     # HTML → styled terminal text
```

## 🗄️ Data Storage

All data is stored in `~/.tbook/`:
- `tbook.db` — SQLite database (books, bookmarks, reading stats)

## 📄 License

MIT
