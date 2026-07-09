# EPUB Rendering Improvement TODO

## Goal
Improve EPUB parsing/rendering fidelity for semantics, inline styling, and image resolution.

## Tasks

- [x] **Fix inline node parsing bug** in `cleanTextWithInlineCode()`
  - [x] Use current node (`n`) instead of outer `node` for attributes (`img`, noteref handling).

- [x] **Respect EPUB semantics (`epub:type` / ARIA roles)**
  - [x] Detect chapter/part/appendix/foreword/preface/prologue/epilogue/index/bibliography blocks.
  - [x] Emit semantic headings for those blocks.
  - [x] Detect pagebreak markers and emit separators.
  - [x] Improve footnote/endnote semantic detection.

- [x] **Improve image path resolution**
  - [x] Track chapter `sourceHref` for relative asset resolution.
  - [x] Normalize image keys in `imageMap`.
  - [x] Resolve relative paths against current chapter directory in reader.
  - [x] Add safer candidate matching (decoded/normalized/basename/suffix).

- [x] **Preserve inline emphasis from EPUB HTML**
  - [x] Convert `<strong>/<b>` to `**...**` markers in parser.
  - [x] Convert `<em>/<i>` to `*...*` markers in parser.
  - [x] Add `formatInlineRichText()` to render `code + bold + italic`.
  - [x] Use rich formatter in both reader rendering paths.

- [x] **Smarter chapter filtering (boilerplate/TOC noise)**
  - [x] Add `isLikelyBoilerplateSection()` heuristic.
  - [x] Skip low-value TOC/copyright/imprint fragments.

## Next pass (recommended)

- [x] Replace plain inline markers with tokenized inline spans for truly lossless nested formatting.
- [x] Add TOC-aware chapter ordering fallback when malformed spine order appears.
- [x] Add optional "show front matter" toggle (currently some front-matter is filtered heuristically).
- [x] Add regression fixtures (`.epub`) + snapshot tests for parser output.
