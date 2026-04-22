# 📖 TBook TUI

A premium **Terminal Book Reader** built with [OpenTUI](https://opentui.com) — read EPUB books in your terminal with a modern, visually stunning interface.

## ✨ Features

- **Premium UI** — Tokyo Night color scheme, ASCII art logo, gradient progress bars
- **EPUB Support** — Full chapter parsing with styled headings, quotes, and paragraphs
- **Library Management** — SQLite-backed book library with search and sorting
- **Reading Progress** — Automatic save/resume with per-book tracking
- **Reading Stats** — Daily word count charts and streak tracking
- **Bookmarks** — Save and jump to positions within books
- **File Import** — Recursive filesystem scanning for EPUB files
- **Vim Keybinds** — `j/k` scroll, `h/l` chapters, `space` page-down

## 🚀 Quick Start

```bash
# Prerequisites: Bun + Zig
bun install
bun start
```

## 🎮 Controls

| Key | Action |
|-----|--------|
| `j` / `k` | Scroll up/down |
| `h` / `l` | Previous/next chapter |
| `Space` | Page down |
| `Tab` | Toggle chapter sidebar |
| `b` | Add bookmark |
| `/` | Search |
| `n` | Import books |
| `i` | Reading stats |
| `q` | Back / Quit |
| `?` | Help |

## 📁 Architecture

```
src/
├── app.ts              # View routing & lifecycle
├── views/
│   ├── splash.ts       # ASCII art welcome screen
│   ├── library.ts      # Book grid with progress cards
│   ├── reader.ts       # Main reading experience
│   ├── import.ts       # File scanner & importer
│   └── stats.ts        # Reading statistics dashboard
├── components/
│   ├── status-bar.ts   # Bottom bar with progress & keybinds
│   └── toast.ts        # Auto-dismissing notifications
├── services/
│   ├── database.ts     # SQLite via bun:sqlite
│   └── epub-parser.ts  # EPUB → structured chapters
└── utils/
    ├── theme.ts        # Tokyo Night Book color system
    └── html-to-text.ts # HTML → styled terminal text
```

## 📄 License

MIT
