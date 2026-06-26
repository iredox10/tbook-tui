import { parse as parseHTML } from "node-html-parser";
import { readFileSync } from "fs";

const xml = readFileSync("test2.xml", "utf-8");
const root = parseHTML(xml);
const texts = root.querySelectorAll("text");
for (const t of texts) {
    let rawHtml = t.innerHTML;
    console.log("Raw HTML:", rawHtml);
    // basic replace
    let md = rawHtml
        .replace(/<b>(.*?)<\/b>/g, "**$1**")
        .replace(/<i>(.*?)<\/i>/g, "*$1*")
        .replace(/<a href="([^"]*)">(.*?)<\/a>/g, "$2");
    console.log("Markdown:", md);
}
