// A small, safe Markdown renderer for chat bubbles. Everything is escaped
// first; only a fixed set of constructs is turned back into HTML.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function safeUrl(url) {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[\w./-]+$/.test(u)) return `/api/files/raw?path=${encodeURIComponent(u)}`;
  return "#";
}

function inline(text, ctx) {
  // Protect inline code first.
  const codes = [];
  let t = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${esc(safeUrl(url.replace(/&amp;/g, "&")))}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  if (ctx?.handles) {
    t = t.replace(/(^|[^\w@.])@([a-z0-9][a-z0-9-]*)/gi, (m, pre, h) => (ctx.handles.has(h.toLowerCase()) || /^(everyone|user)$/i.test(h) ? `${pre}<span class="mention">@${h}</span>` : m));
  }
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

export function renderMarkdown(src, ctx) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inline(l, ctx)).join("<br>")}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // Any info string ("c++", "ts title=x"); the fence closes on at least as many backticks.
    // Fences inside list items are indented; strip that indent from the code too.
    const fence = /^(\s*)(`{3,})[^`]*$/.exec(line);
    if (fence) {
      flush();
      // Like CommonMark: the closing fence may be indented up to 3 spaces past the opener, no more
      // (a deeper ``` line, e.g. an example inside a docstring, is part of the code).
      const close = new RegExp(`^ {0,${fence[1].length + 3}}\`{${fence[2].length},}\\s*$`);
      const indent = new RegExp(`^ {0,${fence[1].length}}`);
      const buf = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++].replace(indent, ""));
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length + 1}>${inline(h[2], ctx)}</h${h[1].length + 1}>`);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const itemRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      // A code fence ends the list item, so the fence handler renders it as a block (not folded into the text).
      const isContinuation = (l) => /^\s{2,}\S/.test(l) && !/^\s*([-*+]|\d+[.)])\s+/.test(l) && !/^\s*`{3,}[^`]*$/.test(l);
      const nextNonBlank = (from) => {
        let j = from;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        return j;
      };
      const start = ordered ? Number(/^\s*(\d+)/.exec(line)[1]) : 1;
      const items = [];
      while (i < lines.length && itemRe.test(lines[i])) {
        // An item is its first line plus indented lines; a blank line before more indented text starts a new paragraph in it.
        const parts = [lines[i].replace(itemRe, "")];
        i++;
        for (;;) {
          while (i < lines.length && isContinuation(lines[i])) parts[parts.length - 1] += " " + lines[i++].trim();
          const j = nextNonBlank(i);
          if (j > i && j < lines.length && isContinuation(lines[j])) {
            parts.push("");
            i = j;
            parts[parts.length - 1] = lines[i++].trim();
            continue;
          }
          break;
        }
        const task = /^\[( |x)\]\s+/i.exec(parts[0]);
        if (task) parts[0] = parts[0].slice(task[0].length);
        const html = parts.map((p) => inline(p, ctx)).join("<br>");
        items.push(task ? `${task[1].trim() ? "☑" : "☐"} ${html}` : html);
        // Loose lists: blank lines between items keep the list (and its numbering) going.
        const j = nextNonBlank(i);
        if (j > i && j < lines.length && itemRe.test(lines[j])) i = j;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${buf.map((l) => inline(l, ctx)).join("<br>")}</blockquote>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const row = (l) => l.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flush();
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join("");
}
