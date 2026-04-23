// ─────────────────────────────────────────────────────────────
// Dictionary Modal — word definition lookup overlay
// ─────────────────────────────────────────────────────────────

import type { CliRenderer } from "@opentui/core"
import {
    BoxRenderable, TextRenderable, ScrollBoxRenderable,
    InputRenderable, InputRenderableEvents,
    t, bold, italic, fg,
} from "@opentui/core"
import { theme } from "../utils/theme"
import { lookupWord, type DictionaryEntry } from "../services/dictionary"

export class DictionaryModal {
    private renderer: CliRenderer
    private container!: BoxRenderable
    private resultBox!: ScrollBoxRenderable
    private input!: InputRenderable
    private visible = false
    private resultNodes: TextRenderable[] = []
    private onClose: () => void
    private inputHandler: ((seq: string) => boolean) | null = null

    constructor(renderer: CliRenderer, onClose: () => void) {
        this.renderer = renderer
        this.onClose = onClose
    }

    show(initialWord?: string) {
        if (this.visible) return
        this.visible = true

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

        // Title
        this.container.add(new TextRenderable(this.renderer, {
            id: "dict-title",
            content: t` ${bold(fg(theme.accent.green)("📚 Dictionary"))}`,
        }))

        // Input
        const inputRow = new BoxRenderable(this.renderer, {
            id: "dict-input-row",
            width: "100%",
            height: 1,
            flexDirection: "row",
            gap: 1,
            paddingLeft: 1,
        })

        this.input = new InputRenderable(this.renderer, {
            id: "dict-input",
            width: 30,
            placeholder: "Type a word...",
            value: initialWord || "",
            backgroundColor: theme.bg.surface,
            focusedBackgroundColor: theme.bg.hover,
            textColor: theme.text.body,
            cursorColor: theme.accent.green,
        })

        inputRow.add(this.input)
        this.container.add(inputRow)

        // Separator
        this.container.add(new TextRenderable(this.renderer, {
            id: "dict-sep",
            content: " " + "┄".repeat(36),
            fg: theme.border.normal,
        }))

        // Results area
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

        // Footer
        this.container.add(new TextRenderable(this.renderer, {
            id: "dict-footer",
            content: t`${fg(theme.text.subtle)(" ⏎ Look up · Esc Close")}`,
        }))

        this.renderer.root.add(this.container)
        this.input.focus()

        // If initial word provided, look it up immediately
        if (initialWord && initialWord.trim().length > 1) {
            this.doLookup(initialWord)
        }

        // Submit on enter
        this.input.on(InputRenderableEvents.ENTER, () => {
            this.doLookup(this.input.value)
        })

        // Input handler — prepend for high priority (runs before reader's handler)
        this.inputHandler = (seq: string) => {
            if (!this.visible) return false
            if (seq === "\x1b" || seq === "\x1b\x1b" || seq === "q") {
                this.hide()
                return true
            }
            // Scroll results with j/k
            if (seq === "j" || seq === "\x1b[B") {
                this.resultBox.scrollBy(1)
                return true
            }
            if (seq === "k" || seq === "\x1b[A") {
                this.resultBox.scrollBy(-1)
                return true
            }
            return false
        }
        this.renderer.prependInputHandler(this.inputHandler)
    }

    private async doLookup(word: string) {
        const clean = word.trim()
        if (clean.length < 2) return

        // Clear previous results
        this.clearResults()

        // Show loading
        const loading = new TextRenderable(this.renderer, {
            id: "dict-loading",
            content: t`\n  ${fg(theme.accent.cyan)("⠋")} Looking up "${clean}"...`,
        })
        this.resultBox.add(loading)
        this.resultNodes.push(loading)

        const entry = await lookupWord(clean)

        // Clear loading
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

        this.renderEntry(entry)
    }

    private renderEntry(entry: DictionaryEntry) {
        // Word + phonetic
        const wordNode = new TextRenderable(this.renderer, {
            id: "dict-word",
            content: entry.phonetic
                ? t`\n  ${bold(fg(theme.accent.green)(entry.word))}  ${fg(theme.text.subtle)(entry.phonetic)}`
                : t`\n  ${bold(fg(theme.accent.green)(entry.word))}`,
        })
        this.resultBox.add(wordNode)
        this.resultNodes.push(wordNode)

        // Meanings
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

        // Source
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
