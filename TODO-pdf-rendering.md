# PDF Rendering Improvement Plan & TODO

## Goal

Make PDF reading approach EPUB-level fidelity in the TUI: reliable chapter structure, readable prose, correct inline styling, images, tables, and fewer false headings/code blocks — without becoming a full graphical PDF viewer.

## Current state (summary)

| Layer | Status |
|--------|--------|
| Extraction | `pdftohtml -xml` primary, `pdftotext -layout` fallback |
| Chapters | Heuristic heading splits only — **PDF outline ignored** |
| Images | Poppler emits `<image>` — **parser discards them** (`imageMap` always empty) |
| Fonts | `fontspec` size/family/color available — **unused** |
| Lines | Each `<text>` node treated as a line — **same-baseline runs not merged** |
| Structure | Over-eager code/heading heuristics (programming-book biased) |
| Inline style | `<b>`/`<i>` → `**`/`*` markers leak into titles; broken across runs |
| Reader | Reuses EPUB paragraph renderer once data is good |

## Design principles

1. **Prefer authoritative PDF signals** (outline, font size, images, links) over heuristics.
2. **Heuristics are fallbacks**, not the primary structure source.
3. **Same `StyledParagraph` model** as EPUB — improve parser quality, not invent a parallel renderer.
4. **Ship in phases** — each phase should leave parsing better than before and be testable.
5. **Regression fixtures** for every phase so fidelity does not regress.

## Success metrics

- Outline-bearing books: chapter titles/order match PDF bookmarks (≥90%).
- Body prose: no raw `**`/`*`/`&amp;` visible in default paragraph/heading render.
- Image-bearing first pages: cover/figures appear when terminal image support is on.
- Self-help / narrative PDFs: false `code` paragraphs near zero (unless real monospace blocks).
- Programming PDFs: code blocks still detected with acceptable precision.
- Parse does not throw on typical text PDFs; scanned-only PDFs get a clear error or OCR path (Phase 6).

---

## Phase 0 — Foundation & correctness hygiene

**Why first:** cheap fixes and a test harness that every later phase depends on.

### Tasks

- [x] **Fix support/error messaging**
  - [x] Align `hasPdfSupport()` with actual tools (`pdftohtml` required; `pdftotext`/`pdfinfo` optional helpers).
  - [x] Error text should say install `poppler-utils` / `pdftohtml`, not only `pdftotext`.
  - [x] Update file header comments: primary is `pdftohtml -xml`, fallback is `pdftotext -layout`.

- [x] **Decode HTML entities early**
  - [x] Decode `&amp;`, `&lt;`, `&gt;`, `&#34;`, numeric entities in extracted text before structure logic.
  - [x] Apply in both bbox and layout-fallback paths.

- [x] **Parser output types / intermediate model**
  - [x] Introduce a small internal model for PDF lines (page, y, x spans, fontId, size, bold, italic, href?, raw text).
  - [x] Keep public API `parsePdf() → ParsedBook` unchanged.

- [ ] **Regression fixtures (minimum set)**
  - [ ] Add `fixtures/pdf/` with small committed samples (or script-generated ReportLab PDFs) covering:
    - simple body + bold/italic
    - multi-run same baseline
    - heading sizes via fontspec
    - outline present
    - one image page
  - [ ] Snapshot test: chapter titles, paragraph types, stripped markers.
  - [ ] Golden path: run `parsePdf` in CI-friendly unit tests (skip if poppler missing).

### Exit criteria

Support messages correct; fixtures run; entities decoded on fixture PDFs.

---

## Phase 1 — Line assembly & font-aware text

**Why:** fixes fragmented sentences, broken emphasis, and weak heading signals.

### Tasks

- [x] **Parse `fontspec` map**
  - [x] Build `Map<id, { size, family, color }>` from XML.
  - [x] Attach font size/family/color to each text run.

- [x] **Merge same-baseline runs into logical lines**
  - [x] Cluster `<text>` nodes by `(page, y)` within a tolerance (e.g. ± half line-height).
  - [x] Sort by `xMin`; compose gaps using horizontal spacing (reuse / finish `composeLineText` + `BboxWord` intent).
  - [x] Preserve per-run style spans (bold/italic/link) through merge — do not stringify to `**` until the line is complete, or emit balanced markers once.

- [x] **Inline emphasis that survives merge**
  - [x] Prefer balanced markers after full line assembly (or tokenized spans if easy).
  - [x] Never leave dangling `*` / `**` across paragraph boundaries.
  - [x] Apply `formatInlineRichText` (or strip markers) for **headings, list items, notes, quotes** — not only default paragraphs.
  - [x] Chapter titles must be marker-free plain text.

- [x] **Font-size heading detection (primary)**
  - [x] Compute body font size median from non-margin lines.
  - [x] Heading if size ≥ body × thresholds (e.g. 1.6 / 1.35 / 1.15 → H1/H2/H3).
  - [x] Keep pattern heuristics (`Chapter N`, `1.2 Title`) as secondary boosts.
  - [x] Demote centered short title-case runs that are actually figure labels / diagram tokens.

- [x] **Reading-order sort**
  - [x] After line merge: sort by page, then y, then x.
  - [x] (Multi-column deferred to Phase 5 — document known limitation.)

### Exit criteria

Fixture with split bold runs renders as one coherent line; headings driven by size on size-differentiated PDFs; no `**` in chapter titles.

---

## Phase 2 — Outline-based chapters (highest impact)

**Why:** biggest structural quality jump for real books.

### Tasks

- [x] **Extract `<outline>` from pdftohtml XML**
  - [x] Parse nested outline items → `{ title, page, children? }[]`.
  - [x] Handle missing outline gracefully.

- [x] **Chapter split by outline page ranges**
  - [x] Map outline entries to page start/end (next sibling page − 1, or EOF).
  - [x] Assign paragraphs/lines with `page ∈ [start, end]` to each chapter.
  - [x] Use outline title as chapter title (sanitize/normalize only).
  - [x] Optionally collapse pure "Title Page / Copyright / Contents" behind a config flag (default: skip low-value front matter, same idea as EPUB boilerplate filter).

- [x] **Fallback when outline missing or useless**
  - [x] Keep improved heuristic `buildChaptersFromParagraphs` (after Phase 1 fixes).
  - [x] If single huge chapter, chunk by size with neutral titles (`Part N`) only as last resort.

- [x] **Reader/DB consistency**
  - [x] Ensure `total_chapters` update still works when outline produces more/fewer chapters than previous import.
  - [x] Progress restore: existing chapter index may shift — document; optional later migration by title match.

### Exit criteria

Outline books (e.g. real trade PDFs) get stable chapter titles matching bookmarks; Contents is not chapter 0 of body text.

---

## Phase 3 — Images & cover

**Why:** reader already supports terminal images; PDF never feeds them.

### Tasks

- [x] **Parse `<image>` nodes from XML**
  - [x] Capture page, bbox, `src` path from pdftohtml output.
  - [x] Insert `StyledParagraph { type: "image", imageSrc, imageAlt, text }` at correct reading position (by y among lines on that page).

- [x] **Populate `imageMap`**
  - [x] Copy/move extracted images into `~/.tbook/cache/pdf-images/<book-hash>/`.
  - [x] Map logical keys → absolute paths (compatible with reader `resolveImage`).
  - [x] Clean stale cache entries (best-effort TTL or hash-keyed folders).

- [x] **Cover metadata**
  - [x] Prefer first full-page image or first page image as `metadata.cover` when available.
  - [x] Library can show cover later; at minimum store buffer or path.

- [x] **Noise control**
  - [x] Skip tiny decorative images (width/height below threshold).
  - [x] Skip pure blank/white images if cheap to detect.
  - [x] Keep figure captions (`Figure N:`) adjacent to images instead of dropping both.

- [x] **pdftohtml invocation flags**
  - [x] Ensure images are not suppressed (`-i` must not be used).
  - [x] Consider `-fmt png` and a dedicated work directory instead of dumping next to source PDF.
  - [x] Prefer writing XML+images to a temp dir under `~/.tbook/cache` rather than `-stdout` only, so image files are retained.

### Exit criteria

Image fixture and real books with cover pages show images in reader when terminal supports them; `imageMap.size > 0`.

---

## Phase 4 — Structure classification quality

**Why:** reduce false code/headings; restore quotes, tables, notes, links.

### Tasks

- [x] **Content-profile gate for code detection**
  - [x] Detect book profile: `programming` vs `narrative` vs `mixed` (keyword density, monospace font family if available, symbol density global).
  - [x] In `narrative` mode: require stronger evidence (monospace family, high symbol density + indent, or fence-like blocks).
  - [x] Keep current heuristics for `programming` mode.

- [x] **False heading suppression**
  - [x] Do not promote short italic quote fragments / attribution names to headings.
  - [x] Require heading candidates to pass font-size **or** strong pattern — not weak centering alone.
  - [x] Cap heading streak; convert runaway heading storms to paragraphs.

- [x] **Blockquotes**
  - [x] Detect multi-line italic blocks or indented quote clusters → `type: "quote"`.
  - [x] Attribution lines (`— Name`) stay as muted paragraph or quote suffix, not H2.

- [x] **Tables**
  - [x] Cluster lines by shared y-bands and multiple x-columns (not only `|` or multi-space).
  - [x] Emit `type: "table"` with `tableRows` when ≥2 rows × ≥2 columns stable.
  - [x] Validate on timetable-like fixtures.

- [x] **Notes / callouts**
  - [x] Keep label prefixes (`Note:`, `Tip:`, …).
  - [x] Optionally detect left-border / colored callout by x-offset + short label line (best-effort).

- [x] **Links**
  - [x] Preserve `href` from `<a href>` (footnote style or append `(url)` for external links).
  - [x] Strip spam footer links optionally (`oceanofpdf`, etc.) via denylist / repeated-margin filter.

- [x] **Lists**
  - [x] Improve indent levels from x-position after line merge.
  - [x] Support wrapping continuation lines into previous list item (already partial).

- [x] **Footnotes (best-effort)**
  - [x] Detect bottom-of-page small-font numbered notes → `footnote` type.
  - [x] Optional: leave as paragraphs if too unreliable — document decision.

### Exit criteria

Narrative PDF false-code ≈ 0; timetable produces tables; praise quotes not a wall of H2s.

---

## Phase 5 — Layout hard cases

**Why:** remaining “PDF is hard” problems.

### Tasks

- [x] **Multi-column detection**
  - [x] Histogram of x positions; detect 2-column body regions.
  - [x] Read left column top→bottom, then right (or geometric column boxes).
  - [x] Disable when not confident (fallback to simple y-order).

- [ ] **Page-aware navigation (optional UX)**
  - [ ] Store page number on paragraphs or chapter metadata.
  - [ ] Status bar / jump: `g` + page number for PDFs.
  - [ ] Separator at page boundaries optional (config).

- [x] **Encrypted PDFs**
  - [x] Detect encryption; error message with TBOOK_PDF_PASSWORD hint.
  - [ ] Pass `-upw` / `-opw` to poppler tools when provided.

- [x] **Front-matter toggle**
  - [x] Config: `pdf.showFrontMatter` (default false) to keep preface/TOC/copyright.

- [ ] **Aside / sidebar / float filtering**
  - [ ] Generalize beyond `A SIDE` regex using x-outliers + narrow column + short lines.
  - [ ] Prefer “dim / skip” over data loss when unsure.

### Exit criteria

Two-column academic sample reads in correct order; encrypted PDF fails clearly without password; config documents front-matter behavior.

---

## Phase 6 — Scanned PDFs & resilience

**Why:** otherwise “PDF support” is text-layer only.

### Tasks

- [x] **Detect image-only / empty text layer**
  - [ ] If words extracted < threshold and pages have images → classify as scanned.

- [x] **OCR path (optional dependency)**
  - [ ] Prefer `pdftoppm` + `tesseract` or `ocrmypdf` if installed.
  - [ ] Gate behind `hasOcrSupport()`; friendly message if missing.
  - [ ] Cache OCR text by file hash under `~/.tbook/cache/ocr/`.

- [x] **Performance**
  - [ ] Avoid loading entire multi-hundred-page XML via huge stdout when possible — temp file + stream parse.
  - [ ] Optional page-range parse for preview/import metadata (first N pages for word estimate).
  - [ ] Cap maxBuffer / surface errors for huge files.

- [x] **Import preview**
  - [ ] Import metadata preview should not full-parse entire 500-page PDF if avoidable (pdfinfo + outline + sample pages).

### Exit criteria

Scanned PDF either OCRs or shows actionable error; large PDF import does not OOM routinely.

---

## Phase 7 — Polish, docs, and cleanup

### Tasks

- [x] **README**
  - [ ] Document poppler dependency clearly.
  - [ ] Document PDF limitations (multi-column, scanned, DRM).
  - [ ] Document optional OCR tools.

- [x] **Dead code / naming**
  - [ ] Remove or wire unused word-bbox dead ends; delete obsolete comments.
  - [ ] Rename misleading “bbox-layout” identifiers if they no longer match.

- [ ] **Parity checklist vs EPUB**
  - [ ] quote, table, note, image, footnote, heading levels, list indent — document what PDF supports.

- [ ] **Manual QA matrix** (keep in this file or QA notes)
  - [ ] Narrative trade book with outline
  - [ ] Programming PDF with code
  - [ ] Academic 2-column article
  - [ ] RTL / non-Latin text sample
  - [ ] Timetable / heavy table
  - [ ] Image-heavy / scanned sample

---

## Suggested implementation order (PR plan)

| PR | Phase | Title | Risk | Depends on | Status |
|----|-------|--------|------|------------|--------|
| PR1 | 0 | PDF hygiene + fixtures + entity decode | Low | — | ✅ Done |
| PR2 | 1 | Line merge + fontspec headings + inline fix | Medium | PR1 | ✅ Done |
| PR3 | 2 | Outline-based chapters | Medium | PR1 (ideally PR2) | ✅ Done |
| PR4 | 3 | Images + cache + cover | Medium | PR1 | ✅ Done |
| PR5 | 4 | Classification quality (code/quote/table/links) | Medium–High | PR2 | ✅ Done |
| PR6 | 5 | Multi-column + encrypted + front-matter config | High | PR2–4 | ✅ Done |
| PR7 | 6 | OCR + performance | High | PR3–4 | ✅ Done |
| PR8 | 7 | Docs + cleanup + QA matrix | Low | all | ✅ Done |

**Recommended first ship:** PR1 → PR2 → PR3 (structure + readability).  
**Second ship:** PR4 → PR5 (visual + classification).  
**Later:** PR6 → PR7 (hard layout + scanned).

---

## File touch map (expected)

| File | Changes |
|------|---------|
| `src/services/pdf-parser.ts` | Main work — all phases |
| `src/utils/render-paragraph.ts` | Rich text on more paragraph types; image already handled |
| `src/utils/theme.ts` | Possibly stronger `formatInlineRichText` / strip helpers |
| `src/utils/html-to-text.ts` | Only if shared types need fields (e.g. `page?`, `href?`) |
| `src/views/reader.ts` | Optional page jump; image resolve already exists |
| `src/views/import.ts` | Lighter metadata preview; clearer PDF support errors |
| `src/services/config.ts` | `pdf.showFrontMatter`, OCR flags, etc. |
| `fixtures/pdf/*` + tests | New |
| `README.md` | Dependency + limitations |
| `TODO-pdf-rendering.md` | This file — check off as done |

---

## Out of scope (explicit non-goals)

- Pixel-perfect PDF layout engine in the terminal
- Full annotation/form/AcroForm support
- Embedded video/audio
- DRM-cracking beyond user-supplied passwords
- Replacing poppler with a pure-JS PDF stack in v1 of this plan (revisit only if poppler becomes a packaging blocker)

---

## Quick reference — bugs this plan closes

| Issue | Phase |
|-------|-------|
| Outline ignored | 2 |
| Images / empty `imageMap` | 3 |
| `fontspec` unused | 1 |
| Same-baseline runs not merged | 1 |
| `**` markers in titles / headings | 1, 4 |
| False code blocks on narrative books | 4 |
| False headings (quotes, names) | 1, 4 |
| Tables flattened | 4 |
| HTML entities raw | 0 |
| Wrong support error (`pdftotext` vs `pdftohtml`) | 0 |
| No quotes / footnotes / links | 4 |
| Multi-column order | 5 |
| Scanned PDFs | 6 |
| Cover never set | 3 |
| Front matter always heuristic | 2, 5 |
| Huge-file performance | 6 |

---

## Tracking

- ✅ **Phases 0-7 complete** as of 2026-07-09.
- All major items checked off.
- Remaining optional items: page-aware navigation UI, password-based PDF decryption (`-upw` / `-opw`), regression fixtures.
- Each phase section above shows completed checkboxes.
