// ─────────────────────────────────────────────────────────────
// Syntax Highlighter — terminal-friendly code colorization
// ─────────────────────────────────────────────────────────────
//
// Detects language from CSS class or content heuristics,
// then applies ANSI color codes to keywords, strings, comments,
// numbers, and operators for terminal display.

import { getTheme } from "./theme"

// Language detection from CSS class names like "language-python", "hljs-javascript", etc.
export function detectLanguage(classAttr: string): string {
    if (!classAttr) return "text"
    const match = classAttr.match(/(?:language-|lang-|hljs-?)(\w+)/i)
    if (match) return match[1]!.toLowerCase()
    // Direct class names
    const directLangs = ["python", "javascript", "typescript", "rust", "go", "java", "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin", "bash", "sh", "zsh", "sql", "html", "css", "json", "yaml", "toml", "xml", "markdown", "lua", "r", "scala", "haskell", "elixir", "clojure", "lisp", "scheme"]
    for (const lang of directLangs) {
        if (classAttr.toLowerCase().includes(lang)) return lang
    }
    return "text"
}

// Detect language from code content heuristically
export function detectLanguageFromContent(code: string): string {
    const trimmed = code.trim()

    // Rust
    if (/\bfn\s+\w+|impl\s+\w+|let\s+mut\b|use\s+\w+::|pub\s+fn\b|-> \w+/.test(trimmed)) return "rust"
    // Python
    if (/\bdef\s+\w+|import\s+\w+|from\s+\w+\s+import|class\s+\w+.*:|print\s*\(|if\s+.*:\s*$|elif\b/.test(trimmed)) return "python"
    // JavaScript / TypeScript
    if (/\bconst\s+\w+|let\s+\w+|function\s+\w+|=>\s*{|export\s+(default\s+)?|import\s+.*from\s+/.test(trimmed)) return "javascript"
    // Go
    if (/\bfunc\s+\w+|package\s+\w+|fmt\.Print|:=\s|go\s+func/.test(trimmed)) return "go"
    // Java / C#
    if (/\bpublic\s+static\s+void|System\.out\.print|class\s+\w+\s*{|new\s+\w+\(/.test(trimmed)) return "java"
    // C / C++
    if (/\b#include\s*<|int\s+main\s*\(|printf\s*\(|std::/.test(trimmed)) return "c"
    // SQL
    if (/\bSELECT\s+|FROM\s+|WHERE\s+|INSERT\s+INTO|CREATE\s+TABLE/i.test(trimmed)) return "sql"
    // Bash
    if (/^#!/.test(trimmed) || /\becho\s+|apt\s+install|npm\s+|pip\s+|cargo\s+|bun\s+/.test(trimmed)) return "bash"
    // HTML
    if (/^<(!DOCTYPE|html|head|body|div|span)/i.test(trimmed)) return "html"
    // JSON
    if (/^\s*[{[]/.test(trimmed) && /["']:\s/.test(trimmed)) return "json"
    // YAML
    if (/^\w+:\s+\S/m.test(trimmed) && !trimmed.includes("{")) return "yaml"

    return "text"
}

// ANSI escape helpers
const ESC = "\x1b["
const RESET = `${ESC}0m`
const ansi = {
    keyword: (s: string) => `${ESC}35m${s}${RESET}`,     // magenta
    builtin: (s: string) => `${ESC}36m${s}${RESET}`,      // cyan
    string: (s: string) => `${ESC}33m${s}${RESET}`,       // yellow
    comment: (s: string) => `${ESC}90m${s}${RESET}`,      // gray
    number: (s: string) => `${ESC}34m${s}${RESET}`,       // blue
    operator: (s: string) => `${ESC}31m${s}${RESET}`,     // red
    type: (s: string) => `${ESC}32m${s}${RESET}`,         // green
    function: (s: string) => `${ESC}33m${s}${RESET}`,     // yellow
    punctuation: (s: string) => `${ESC}90m${s}${RESET}`,  // gray
    decorator: (s: string) => `${ESC}33m${s}${RESET}`,    // yellow
}

// Language-specific keyword sets
const KEYWORDS: Record<string, string[]> = {
    javascript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "class", "extends", "new", "this", "super", "import", "export", "default", "from", "async", "await", "yield", "typeof", "instanceof", "in", "of", "delete", "void", "null", "undefined", "true", "false", "NaN", "Infinity"],
    typescript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "class", "extends", "new", "this", "super", "import", "export", "default", "from", "async", "await", "yield", "typeof", "instanceof", "in", "of", "delete", "void", "null", "undefined", "true", "false", "type", "interface", "enum", "namespace", "abstract", "implements", "readonly", "as", "is", "keyof", "never", "unknown", "any"],
    python: ["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "try", "except", "finally", "raise", "import", "from", "as", "with", "pass", "lambda", "yield", "global", "nonlocal", "assert", "del", "True", "False", "None", "and", "or", "not", "in", "is", "async", "await"],
    rust: ["fn", "let", "mut", "const", "static", "if", "else", "match", "for", "while", "loop", "break", "continue", "return", "struct", "enum", "impl", "trait", "type", "use", "mod", "pub", "crate", "self", "super", "as", "where", "async", "await", "move", "unsafe", "extern", "ref", "true", "false", "Some", "None", "Ok", "Err"],
    go: ["func", "var", "const", "type", "struct", "interface", "map", "chan", "go", "select", "case", "default", "if", "else", "for", "range", "switch", "break", "continue", "return", "defer", "package", "import", "true", "false", "nil", "make", "new", "append", "len", "cap"],
    java: ["public", "private", "protected", "static", "final", "abstract", "class", "interface", "extends", "implements", "new", "this", "super", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "throws", "import", "package", "void", "int", "long", "double", "float", "boolean", "char", "byte", "short", "String", "null", "true", "false"],
    c: ["int", "long", "short", "float", "double", "char", "void", "unsigned", "signed", "const", "static", "extern", "volatile", "struct", "union", "enum", "typedef", "sizeof", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "goto", "default", "NULL", "true", "false", "#include", "#define", "#ifdef", "#ifndef", "#endif"],
    sql: ["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "ASC", "DESC", "HAVING", "LIMIT", "OFFSET", "AS", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "NULL", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "DEFAULT", "CHECK", "CONSTRAINT", "EXISTS", "IN", "LIKE", "BETWEEN", "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "IF", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "INTEGER", "TEXT", "REAL", "BLOB", "BOOLEAN", "VARCHAR"],
    bash: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "exit", "echo", "read", "local", "export", "source", "eval", "exec", "set", "unset", "shift", "test", "true", "false", "in"],
}

// Builtin types that get a special color
const BUILTIN_TYPES: Record<string, string[]> = {
    javascript: ["Array", "Object", "String", "Number", "Boolean", "Map", "Set", "Promise", "Date", "RegExp", "Error", "JSON", "Math", "console"],
    typescript: ["Array", "Object", "String", "Number", "Boolean", "Map", "Set", "Promise", "Date", "RegExp", "Error", "JSON", "Math", "console", "Record", "Partial", "Required", "Readonly", "Pick", "Omit"],
    python: ["int", "float", "str", "bool", "list", "dict", "tuple", "set", "bytes", "range", "print", "len", "type", "super", "enumerate", "zip", "map", "filter", "sorted", "reversed", "open", "input"],
    rust: ["String", "Vec", "Option", "Result", "Box", "Rc", "Arc", "HashMap", "HashSet", "BTreeMap", "BTreeSet", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64", "usize", "isize", "bool", "char", "str"],
    go: ["string", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64", "bool", "byte", "rune", "error", "any"],
    java: ["Integer", "Long", "Double", "Float", "Boolean", "Character", "Byte", "Short", "Object", "List", "ArrayList", "Map", "HashMap", "Set", "HashSet", "Optional", "Stream"],
    c: ["size_t", "ssize_t", "ptrdiff_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t", "FILE", "bool"],
}

// Comment patterns per language
interface CommentStyle { line?: string; blockStart?: string; blockEnd?: string }
const COMMENT_STYLES: Record<string, CommentStyle> = {
    javascript: { line: "//", blockStart: "/*", blockEnd: "*/" },
    typescript: { line: "//", blockStart: "/*", blockEnd: "*/" },
    rust: { line: "//", blockStart: "/*", blockEnd: "*/" },
    go: { line: "//", blockStart: "/*", blockEnd: "*/" },
    java: { line: "//", blockStart: "/*", blockEnd: "*/" },
    c: { line: "//", blockStart: "/*", blockEnd: "*/" },
    python: { line: "#" },
    bash: { line: "#" },
    sql: { line: "--", blockStart: "/*", blockEnd: "*/" },
}

/**
 * Apply syntax highlighting to a code string.
 * Returns the code with ANSI escape codes embedded.
 */
export function highlightCode(code: string, language: string): string {
    const lang = language.toLowerCase()
    if (lang === "text" || lang === "plaintext" || lang === "output") return code

    const keywords = new Set(KEYWORDS[lang] || KEYWORDS["javascript"]!)
    const builtins = new Set(BUILTIN_TYPES[lang] || [])
    const commentStyle = COMMENT_STYLES[lang] || COMMENT_STYLES["javascript"]!

    const lines = code.split("\n")
    let inBlockComment = false
    const result: string[] = []

    for (const line of lines) {
        if (inBlockComment) {
            // Check if block comment ends on this line
            if (commentStyle.blockEnd && line.includes(commentStyle.blockEnd)) {
                const endIdx = line.indexOf(commentStyle.blockEnd)
                const commentPart = line.slice(0, endIdx + commentStyle.blockEnd.length)
                const rest = line.slice(endIdx + commentStyle.blockEnd.length)
                result.push(ansi.comment(commentPart) + highlightLine(rest, keywords, builtins, commentStyle, lang))
                inBlockComment = false
            } else {
                result.push(ansi.comment(line))
            }
            continue
        }

        // Check if line starts a block comment
        if (commentStyle.blockStart && line.trimStart().startsWith(commentStyle.blockStart)) {
            if (commentStyle.blockEnd && line.includes(commentStyle.blockEnd, line.indexOf(commentStyle.blockStart) + commentStyle.blockStart.length)) {
                // Single-line block comment
                result.push(ansi.comment(line))
            } else {
                inBlockComment = true
                result.push(ansi.comment(line))
            }
            continue
        }

        // Check for line comment
        if (commentStyle.line) {
            const trimmed = line.trimStart()
            if (trimmed.startsWith(commentStyle.line)) {
                result.push(line.slice(0, line.indexOf(commentStyle.line)) + ansi.comment(line.slice(line.indexOf(commentStyle.line))))
                continue
            }
        }

        result.push(highlightLine(line, keywords, builtins, commentStyle, lang))
    }

    return result.join("\n")
}

function highlightLine(
    line: string,
    keywords: Set<string>,
    builtins: Set<string>,
    commentStyle: CommentStyle,
    lang: string,
): string {
    let result = ""
    let i = 0

    while (i < line.length) {
        const ch = line[i]!

        // Line comment mid-line
        if (commentStyle.line && line.slice(i).startsWith(commentStyle.line)) {
            result += ansi.comment(line.slice(i))
            break
        }

        // String literals
        if (ch === '"' || ch === "'" || ch === "`") {
            const quote = ch
            let str = ch
            i++
            while (i < line.length) {
                const c = line[i]!
                str += c
                if (c === "\\" && i + 1 < line.length) {
                    i++
                    str += line[i]!
                } else if (c === quote) {
                    break
                }
                i++
            }
            result += ansi.string(str)
            i++
            continue
        }

        // Decorators (@something)
        if (ch === "@" && /[a-zA-Z]/.test(line[i + 1] || "")) {
            let dec = "@"
            i++
            while (i < line.length && /\w/.test(line[i]!)) {
                dec += line[i]!
                i++
            }
            result += ansi.decorator(dec)
            continue
        }

        // Numbers
        if (/\d/.test(ch) && (i === 0 || !/\w/.test(line[i - 1] || ""))) {
            let num = ""
            while (i < line.length && /[\d.xXaAbBcCdDeEfF_]/.test(line[i]!)) {
                num += line[i]!
                i++
            }
            result += ansi.number(num)
            continue
        }

        // Identifiers (keywords, builtins, types, functions)
        if (/[a-zA-Z_$]/.test(ch)) {
            let word = ""
            const start = i
            while (i < line.length && /[\w$]/.test(line[i]!)) {
                word += line[i]!
                i++
            }
            if (keywords.has(word)) {
                result += ansi.keyword(word)
            } else if (builtins.has(word)) {
                result += ansi.type(word)
            } else if (/^[A-Z]/.test(word) && word.length > 1) {
                // PascalCase = likely a type
                result += ansi.type(word)
            } else if (i < line.length && line[i] === "(") {
                // Followed by ( = function call
                result += ansi.function(word)
            } else {
                result += word
            }
            continue
        }

        // Operators
        if (/[+\-*/%=<>!&|^~?:]/.test(ch)) {
            let op = ""
            while (i < line.length && /[+\-*/%=<>!&|^~?:]/.test(line[i]!)) {
                op += line[i]!
                i++
            }
            result += ansi.operator(op)
            continue
        }

        // Punctuation
        if (/[{}()\[\];,.]/.test(ch)) {
            result += ansi.punctuation(ch)
            i++
            continue
        }

        result += ch
        i++
    }

    return result
}
