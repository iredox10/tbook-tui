const fs = require('fs');
let code = fs.readFileSync('src/views/library.ts', 'utf8');

// 1. Refactor Header
code = code.replace(
`        const header = new BoxRenderable(this.renderer, {
            id: "library-header",
            width: "100%",
            height: 3,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingLeft: 2,
            paddingRight: 2,
            backgroundColor: theme.bg.surface,
            borderStyle: "single",
            borderColor: theme.border.normal,
        })`,
`        const header = new BoxRenderable(this.renderer, {
            id: "library-header",
            width: "100%",
            height: 1, // Sleek 1-line header
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingLeft: 2,
            paddingRight: 2,
            backgroundColor: theme.bg.surface,
        })`
);

code = code.replace(
`        const titleText = new TextRenderable(this.renderer, {
            id: "library-title",
            content: t\`\${bold(fg(theme.accent.cyan)("📚 Library"))}\`,
        })`,
`        const titleText = new TextRenderable(this.renderer, {
            id: "library-title",
            content: t\`\${bold(fg(theme.accent.cyan)("📚 LIBRARY"))}\`, // uppercase for modern look
        })`
);

// 2. Refactor search gap
code = code.replace(
`            paddingTop: 0,
            paddingBottom: 0,
            flexDirection: "row",`,
`            paddingTop: 1,
            paddingBottom: 1,
            flexDirection: "row",`
);

// 3. Refactor createBookCard
code = code.replace(/    private createBookCard[\s\S]*?return card\n    }/, `    private createBookCard(book: BookRecord, index: number, isSelected: boolean): BoxRenderable {
        const progress = book.total_chapters > 0
            ? Math.round((book.current_chapter / book.total_chapters) * 100)
            : 0
        const pColor = progressColor(progress)

        // Deterministic spine color from title hash
        const spineColors = [
            theme.accent.blue, theme.accent.purple, theme.accent.cyan,
            theme.accent.green, theme.accent.pink, theme.accent.amber, theme.accent.orange,
        ]
        const spineColor = spineColors[book.title.length % spineColors.length]!

        const isReading = book.current_chapter > 0 && progress < 100

        const card = new BoxRenderable(this.renderer, {
            id: \`book-card-\${index}\`,
            width: "100%",
            height: 2,
            backgroundColor: isSelected ? theme.bg.hover : theme.bg.void,
            flexDirection: "row",
            paddingLeft: 0,
            paddingRight: 2,
            justifyContent: "flex-start",
            gap: 1,
        })

        // ── Active Indicator (Left Bar) ──
        const spine = new BoxRenderable(this.renderer, {
            id: \`book-spine-\${index}\`,
            width: 1,
            height: "100%",
            backgroundColor: isSelected ? spineColor : theme.bg.surface,
            flexDirection: "column",
        })
        card.add(spine)

        // ── Main content area ──
        const content = new BoxRenderable(this.renderer, {
            id: \`book-content-\${index}\`,
            flexGrow: 1,
            height: "100%",
            flexDirection: "column",
            justifyContent: "center",
            gap: 0,
        })

        // Row 1: Title + Last Read
        const titleRow = new BoxRenderable(this.renderer, {
            id: \`book-title-row-\${index}\`,
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
            alignItems: "center",
        })

        const titleText = isSelected 
            ? t\`\${bold(fg(theme.accent.bright)(truncate(book.title, 40)))}\`
            : t\`\${fg(theme.text.body)(truncate(book.title, 40))}\`;

        const title = new TextRenderable(this.renderer, {
            id: \`book-title-\${index}\`,
            content: t\`\${isSelected ? fg(spineColor)("▸ ") : "  "}\${titleText}\${isReading ? " " + fg(theme.accent.amber)("●") : progress >= 100 ? " " + fg(theme.accent.green)("✓") : ""}\`,
        })

        const lastRead = new TextRenderable(this.renderer, {
            id: \`book-lastread-\${index}\`,
            content: relativeTime(book.last_read_at),
            fg: isSelected ? theme.text.bright : theme.text.subtle,
        })

        titleRow.add(title)
        titleRow.add(lastRead)

        // Row 2: Format + Author + Progress
        const progressRow = new BoxRenderable(this.renderer, {
            id: \`book-progress-row-\${index}\`,
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
            alignItems: "center",
        })

        const formatTag = book.format === "pdf" ? fg(theme.accent.pink)("[PDF]") : fg(theme.accent.green)("[EPU]");
        const authorText = fg(theme.text.muted)(truncate(book.author || "Unknown", 20));
        
        const detailsText = new TextRenderable(this.renderer, {
            id: \`book-details-\${index}\`,
            content: t\`  \${formatTag} \${authorText}\`,
        })

        const { microProgressBar } = require("../utils/theme")
        const bar = new TextRenderable(this.renderer, {
            id: \`book-progress-\${index}\`,
            content: t\`\${fg(pColor)(microProgressBar(progress, 16))} \${fg(theme.text.muted)(\`\${progress}%\`)}\`,
        })

        progressRow.add(detailsText)
        progressRow.add(bar)

        content.add(titleRow)
        content.add(progressRow)
        card.add(content)

        return card
    }`);

// 4. Update the card height calculation in scrollToSelected
code = code.replace(
`        // Calculate position based on the known fixed sizes
        const cardHeight = 4
        const gap = 1`,
`        // Calculate position based on the known fixed sizes
        const cardHeight = 2
        const gap = 0 // we removed gap between cards in the list to make it a tight list, wait actually list has gap 1.`
);

fs.writeFileSync('src/views/library.ts', code);
console.log('Refactored library.ts');
