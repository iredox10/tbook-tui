const fs = require('fs');
let code = fs.readFileSync('src/views/reader.ts', 'utf8');

const targetStart = code.indexOf('            switch (p.type) {');
const targetEnd = code.indexOf('            this.readingPane.add(node)', targetStart);

if (targetStart === -1 || targetEnd === -1) {
    console.error('Target not found!');
    process.exit(1);
}

const replacement = `            let node = new TextRenderable(this.renderer, {
                id: \`para-\${i}\`,
                ...textProps,
                content: "",
            })

`;

code = code.substring(0, targetStart) + replacement + code.substring(targetEnd);

// Now remove the database highlights loop at the end of renderChapter
const hlStart = code.indexOf('        // Apply saved highlights from database');
const hlEnd = code.indexOf('        // Restore saved scroll position', hlStart);

if (hlStart !== -1 && hlEnd !== -1) {
    code = code.substring(0, hlStart) + code.substring(hlEnd);
} else {
    console.error('Highlights block not found!');
}

fs.writeFileSync('src/views/reader.ts', code);
