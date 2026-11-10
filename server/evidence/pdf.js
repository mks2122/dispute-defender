// Minimal dependency-free PDF writer for the evidence packet attached to provide-evidence.
// Text only (Helvetica, WinAnsi), wrapped, multi-page. Pure function: string[] blocks → Buffer.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 56, LEADING = 15, WRAP = 92;

// Typographic characters the model writes, mapped to their WinAnsiEncoding bytes (written as latin1).
const WIN_ANSI = { "\u2018": "\x91", "\u2019": "\x92", "\u201C": "\x93", "\u201D": "\x94", "\u2022": "\x95", "\u2013": "\x96", "\u2014": "\x97", "\u2026": "\x85", "\u20AC": "\x80", "\u2122": "\x99", "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2212": "-", "\u00A0": " " };
/** PDF string literal escaping: typographic characters keep their glyphs, anything else unsupported becomes "?". */
const esc = (s) => s
  .replace(/[\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u2026\u20AC\u2122\u2010-\u2012\u2212\u00A0]/g, (c) => WIN_ANSI[c])
  .replace(/[^\x20-\x7E\x80\x85\x91-\x97\x99\xA0-\xFF]/g, "?")
  .replace(/[\\()]/g, (c) => `\\${c}`);

function wrap(text, width = WRAP) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = "";
    for (const raw of para.split(/\s+/)) {
      if (!raw) continue;
      // Long tokens (URLs, ids) are split across lines, never truncated.
      const pieces = raw.match(new RegExp(`.{1,${width}}`, "g"));
      for (const word of pieces) {
        if ((line + " " + word).trim().length > width) { if (line) out.push(line); line = word; }
        else line = (line + " " + word).trim();
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * @param {{title: string, sections: {heading: string, body: string}[]}} doc
 * @returns {Buffer}
 */
export function renderPdf({ title, sections }) {
  const lines = [{ text: title, size: 16, bold: true }, { text: "", size: 10 }];
  for (const s of sections) {
    lines.push({ text: s.heading, size: 12, bold: true });
    for (const l of wrap(s.body)) lines.push({ text: l, size: 10 });
    lines.push({ text: "", size: 10 });
  }
  const perPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));

  const objects = []; // index 0 → object 1
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogId = add(null);
  const pagesId = add(null);
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const boldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pageIds = [];
  for (const page of pages) {
    let y = PAGE_H - MARGIN;
    const ops = page.map((l) => {
      const op = `BT /${l.bold ? "F2" : "F1"} ${l.size} Tf ${MARGIN} ${y} Td (${esc(l.text)}) Tj ET`;
      y -= LEADING;
      return op;
    }).join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
