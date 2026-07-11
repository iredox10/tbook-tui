// ─────────────────────────────────────────────────────────────
// Dictionary Modal — word definition lookup overlay
// ─────────────────────────────────────────────────────────────
// Uses a plain TextRenderable for the "input" field to avoid
// focus issues — the InputRenderable.focus() silently consumes
// ESC in OpenTUI before any global handler can see it.
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    t, bold, italic, fg,
} from "@opentui/core"
import { theme } from "../utils/theme"
import { lookupWord, type DictionaryEntry } from "../services/dictionary"
import { enableTouchScroll } from "../utils/touch"
import { addToVocabulary } from "../services/database"

export class DictionaryModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private resultBox!: ScrollBoxRenderable
    private inputLabel!: TextRenderable
    private visible = false
    private resultNodes: TextRenderable[] = []
    private onClose: () => void
    private inputHandler: ((seq: string) => boolean) | null = null
    private word = ""
    private inputFocused = true

    constructor(renderer: CliRenderer, onClose: () => void) {
        this.renderer = renderer
        this.onClose = onClose
    }

    show(initialWord?: string) {
        if (this.visible) return
        this.visible = true
        this.word = initialWord || ""
        this.inputFocused = true

        this.container = new BoxRenderable(this.renderer, {
            id: "dict-overlay",
            position: "absolute",
            top: 4,
            bottom: 4,
            left: "20%",
            right: "20%",
            borderStyle: "rounded",
            borderColor: theme.accent.green,
            backgroundColor: theme.bg.card,
            flexDirection: "column",
            padding: 1,
            gap: 1,
        })

        this.container.add(new TextRenderable(this.renderer, {
            id: "dict-title",
            content: t` ${bold(fg(theme.accent.green)("📚 Dictionary"))}`,
        }))

        const inputRow = new BoxRenderable(this.renderer, {
            id: "dict-input-row",
            width: "100%",
            height: 1,
            flexDirection: "row",
            gap: 0,
            paddingLeft: 1,
        })

        // Plain TextRenderable styled as an input field — never receives focus
        this.inputLabel = new TextRenderable(this.renderer, {
            id: "dict-input",
            content: t`${fg(theme.accent.green)("▸ ")}${fg(theme.text.body)((initialWord || "") + "_")}`,
        })
        inputRow.add(this.inputLabel)
        this.container.add(inputRow)

        this.container.add(new TextRenderable(this.renderer, {
            id: "dict-sep",
            content: " " + "┄".repeat(36),
            fg: theme.border.normal,
        }))

        this.resultBox = new ScrollBoxRenderable(this.renderer, {
            id: "dict-results",
            width: "100%",
            flexGrow: 1,
            scrollbarOptions: {
                trackOptions: {
                    foregroundColor: theme.scrollbar.thumb,
                    backgroundColor: theme.scrollbar.track,
                },
            },
            contentOptions: {
                paddingLeft: 1,
                paddingRight: 1,
                flexDirection: "column",
                gap: 0,
                backgroundColor: theme.bg.card,
            },
        })
        this.container.add(this.resultBox)

        enableTouchScroll(this.resultBox, { renderer: this.renderer })

        this.container.add(new TextRenderable(this.renderer, {
            id: "dict-footer",
            content: this.inputFocused
                ? t`${fg(theme.text.subtle)(" Esc Close · ⏎ Look up · Type to search")}`
                : t`${fg(theme.text.subtle)(" Esc/q Close · Tab Edit · j/k Scroll")}`,
        }))

        this.renderer.root.add(this.container)
        this.resultBox.focus()

        if (initialWord && initialWord.trim().length > 1) {
            this.doLookup(initialWord)
        }

        this.inputHandler = (seq: string) => {
            if (!this.visible) return false

            // ESC: ALWAYS close regardless of state
            if (seq === "\x1b" || seq === "\x1b\x1b") {
                this.hide()
                return true
            }

            if (this.inputFocused) {
                if (seq === "\r" || seq === "\n") {
                    this.doLookup(this.word)
                    this.inputFocused = false
                    this.updateFooter()
                    return true
                }

                if (seq === "\x7f" || seq === "\b") {
                    if (this.word.length > 0) {
                        this.word = this.word.slice(0, -1)
                        this.updateInput()
                    }
                    return true
                }

                if (seq === "\x15") {
                    this.word = ""
                    this.updateInput()
                    return true
                }

                // Tab / j/k/arrows: switch to scroll mode
                if (seq === "\t" || seq === "j" || seq === "\x1b[B" ||
                    seq === "k" || seq === "\x1b[A") {
                    this.inputFocused = false
                    this.updateFooter()
                    return true
                }

                if (seq.length === 1) {
                    const ch = seq.charCodeAt(0)
                    if (ch >= 32 && ch < 127 && this.word.length < 60) {
                        this.word += seq
                        this.updateInput()
                        return true
                    }
                }

                return true
            } else {
                // Result-scrolling mode
                if (seq === "q") {
                    this.hide()
                    return true
                }
                if (seq === "j" || seq === "\x1b[B") {
                    this.resultBox.scrollBy(1)
                    return true
                }
                if (seq === "k" || seq === "\x1b[A") {
                    this.resultBox.scrollBy(-1)
                    return true
                }
                // Tab or any printable key: switch back to input mode
                if (seq === "\t") {
                    this.inputFocused = true
                    this.updateFooter()
                    return true
                }
                if (seq.length === 1) {
                    const ch = seq.charCodeAt(0)
                    if (ch >= 32 && ch < 127) {
                        this.inputFocused = true
                        if (!this.word) this.word = ""
                        this.word += seq
                        this.updateInput()
                        this.updateFooter()
                        return true
                    }
                }
                return true
            }
        }
        this.renderer.addInputHandler(this.inputHandler)
    }

    private updateInput() {
        const prefix = this.inputFocused ? "▸ " : "  "
        const text = (this.word || "") + (this.inputFocused ? "_" : "")
        this.inputLabel.content = t`${fg(this.inputFocused ? theme.accent.green : theme.text.muted)(prefix)}${fg(theme.text.body)(text)}`
    }

    private updateFooter() {
        // Note: footer update via re-render — we just update state for now
        // The footer text is set at construction time, minimal updates needed
    }

    private async doLookup(word: string) {
        const clean = word.trim()
        if (clean.length < 2) return

        this.clearResults()

        const loading = new TextRenderable(this.renderer, {
            id: "dict-loading",
            content: t`\n  ${fg(theme.accent.cyan)("⠋")} Looking up "${clean}"...`,
        })
        this.resultBox.add(loading)
        this.resultNodes.push(loading)

        const entry = await lookupWord(clean)

        this.clearResults()

        if (!entry) {
            const notFound = new TextRenderable(this.renderer, {
                id: "dict-not-found",
                content: t`\n  ${fg(theme.text.muted)("No definition found for")} ${fg(theme.accent.pink)(`"${clean}"`)}`,
            })
            this.resultBox.add(notFound)
            this.resultNodes.push(notFound)
            return
        }

        const defSummary = entry.meanings.map(m =>
            `${m.partOfSpeech}: ${m.definitions.map(d => d.definition).join("; ")}`
        ).join(" | ")
        addToVocabulary(clean, defSummary, entry)

        this.renderEntry(entry)
    }

    private renderEntry(entry: DictionaryEntry) {
        const wordNode = new TextRenderable(this.renderer, {
            id: "dict-word",
            content: entry.phonetic
                ? t`\n  ${bold(fg(theme.accent.green)(entry.word))}  ${fg(theme.text.subtle)(entry.phonetic)}`
                : t`\n  ${bold(fg(theme.accent.green)(entry.word))}`,
        })
        this.resultBox.add(wordNode)
        this.resultNodes.push(wordNode)

        for (let mi = 0; mi < entry.meanings.length; mi++) {
            const meaning = entry.meanings[mi]!
            const posNode = new TextRenderable(this.renderer, {
                id: `dict-pos-${mi}`,
                content: t`\n  ${italic(fg(theme.accent.purple)(meaning.partOfSpeech))}`,
            })
            this.resultBox.add(posNode)
            this.resultNodes.push(posNode)

            for (let di = 0; di < meaning.definitions.length; di++) {
                const def = meaning.definitions[di]!
                const defNode = new TextRenderable(this.renderer, {
                    id: `dict-def-${mi}-${di}`,
                    content: t`   ${fg(theme.text.muted)(`${di + 1}.`)} ${fg(theme.text.body)(def.definition)}`,
                    wrapMode: "word",
                })
                this.resultBox.add(defNode)
                this.resultNodes.push(defNode)

                if (def.example) {
                    const exNode = new TextRenderable(this.renderer, {
                        id: `dict-ex-${mi}-${di}`,
                        content: t`      ${italic(fg(theme.text.subtle)(`"${def.example}"`))}`,
                        wrapMode: "word",
                    })
                    this.resultBox.add(exNode)
                    this.resultNodes.push(exNode)
                }
            }
        }

        const srcNode = new TextRenderable(this.renderer, {
            id: "dict-source",
            content: t`\n  ${fg(theme.text.subtle)(`Source: ${entry.source}`)}`,
        })
        this.resultBox.add(srcNode)
        this.resultNodes.push(srcNode)
    }

    private clearResults() {
        for (const node of this.resultNodes) {
            try { this.resultBox.remove(node.id) } catch { }
        }
        this.resultNodes = []
    }

    hide() {
        if (!this.visible) return
        this.visible = false
        if (this.inputHandler) {
            this.renderer.removeInputHandler(this.inputHandler)
            this.inputHandler = null
        }
        try { this.renderer.root.remove(this.container.id) } catch { }
        this.onClose()
    }

    destroy() {
        this.hide()
    }
}
