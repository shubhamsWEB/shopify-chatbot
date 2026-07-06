// Minimal markdown → HTML (tables, headings, rules, lists, bold/italic).
// Escapes input first (XSS-safe), then renders block + inline elements. Mirrors
// the storefront widget's renderer so admin + storefront look consistent.
export function renderMarkdown(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_]+?)_/g, "$1<em>$2</em>");

  const lines = String(text).split("\n");
  const out: string[] = [];
  let i = 0;
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      let t = '<div style="overflow-x:auto;margin:8px 0;border:1px solid #eef0f2;border-radius:10px;"><table style="border-collapse:collapse;font-size:12px;width:100%;">';
      t += "<thead><tr>" + header.map((h) => `<th style="padding:7px 10px;text-align:left;background:#f7f8fa;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
      rows.forEach((r, ri) => {
        t += `<tr style="background:${ri % 2 ? "#fbfbfc" : "#fff"};">` + r.map((c, ci) => `<td style="padding:7px 10px;border-bottom:1px solid #f1f2f4;${ci === 0 ? "font-weight:600;color:#374151;" : "color:#4b5563;"}">${inline(c)}</td>`).join("") + "</tr>";
      });
      out.push(t + "</tbody></table></div>");
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<div style="font-weight:700;margin:10px 0 4px;font-size:14px;color:#111827;">${inline(h[2])}</div>`); i++; continue; }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr style="border:none;border-top:1px solid #eef0f2;margin:8px 0;">'); i++; continue; }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!listOpen) { out.push('<ul style="margin:4px 0;padding-left:18px;">'); listOpen = true; } out.push(`<li>${inline(li[1])}</li>`); i++; continue; }

    if (line.trim() === "") { closeList(); out.push("<br>"); i++; continue; }

    closeList(); out.push(inline(line) + "<br>"); i++;
  }
  closeList();
  return out.join("");
}
