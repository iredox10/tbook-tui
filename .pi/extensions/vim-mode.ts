import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";

const NORMAL_KEY_MAP: Record<string, string | null> = {
  h: "\x1b[D", // left
  j: "\x1b[B", // down
  k: "\x1b[A", // up
  l: "\x1b[C", // right
  w: "\x1bf", // word right (alt+f)
  b: "\x1bb", // word left (alt+b)
  "0": "\x01", // line start (ctrl+a)
  $: "\x05", // line end (ctrl+e)
  x: "\x1b[3~", // delete char
  i: null,
  a: null,
  I: null,
  A: null,
};

class VimEditor extends CustomEditor {
  private mode: Mode = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") {
        this.mode = "normal";
      } else {
        // Keep built-in app escape behavior in normal mode (interrupt, cancel dialogs, etc.)
        super.handleInput(data);
      }
      return;
    }

    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    if (data in NORMAL_KEY_MAP) {
      if (data === "i") {
        this.mode = "insert";
        return;
      }

      if (data === "a") {
        super.handleInput("\x1b[C");
        this.mode = "insert";
        return;
      }

      if (data === "I") {
        super.handleInput("\x01");
        this.mode = "insert";
        return;
      }

      if (data === "A") {
        super.handleInput("\x05");
        this.mode = "insert";
        return;
      }

      const seq = NORMAL_KEY_MAP[data];
      if (seq) super.handleInput(seq);
      return;
    }

    // Ignore plain printable characters in normal mode.
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;

    // Still allow app/editor control keys (ctrl+c, ctrl+d, etc.)
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;

    const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
    const last = lines.length - 1;

    if (visibleWidth(lines[last] ?? "") >= label.length) {
      lines[last] = truncateToWidth(lines[last] ?? "", width - label.length, "") + label;
    }

    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
    ctx.ui.notify("Vim mode enabled (Esc = normal, i/a/I/A = insert)", "info");
  });
}
