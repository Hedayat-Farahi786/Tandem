import PDFDocument from 'pdfkit';
import { marked, type Token, type Tokens } from 'marked';

const plain = (s: string) =>
  s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/**
 * Spec Markdown to PDF with pdfkit's built-in fonts (Helvetica, Courier), so the file is the same on
 * every OS and needs no font files or browser.
 */
export function specPdf(markdown: string, meta: { title: string; subtitle: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: meta.title, Producer: 'Tandem', Creator: 'Tandem' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 112;
    doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(meta.subtitle, { width });
    doc.moveDown(0.6);

    const write = (tokens: Token[]) => {
      for (const t of tokens) {
        switch (t.type) {
          case 'heading': {
            const h = t as Tokens.Heading;
            doc.moveDown(h.depth === 1 ? 0.2 : 0.8);
            doc.font('Helvetica-Bold').fontSize(h.depth === 1 ? 20 : h.depth === 2 ? 14 : 12).fillColor('#111827').text(plain(h.text), { width });
            doc.moveDown(0.3);
            break;
          }
          case 'paragraph':
            doc.font('Helvetica').fontSize(10.5).fillColor('#1f2937').text(plain((t as Tokens.Paragraph).text), { width, lineGap: 2 });
            doc.moveDown(0.5);
            break;
          case 'list': {
            const l = t as Tokens.List;
            l.items.forEach((item, i) => {
              doc.font('Helvetica').fontSize(10.5).fillColor('#1f2937').text(`${l.ordered ? `${(Number(l.start) || 1) + i}.` : '•'}  ${plain(item.text)}`, { width, indent: 10, lineGap: 2 });
            });
            doc.moveDown(0.5);
            break;
          }
          case 'code': {
            const c = t as Tokens.Code;
            const y = doc.y;
            doc.font('Courier').fontSize(9);
            const h = doc.heightOfString(c.text, { width: width - 16 }) + 12;
            if (y + h > doc.page.height - 56) doc.addPage();
            doc.rect(56, doc.y, width, h).fill('#f3f4f6');
            doc.fillColor('#111827').text(c.text, 64, doc.y + 6, { width: width - 16 });
            doc.x = 56;
            doc.moveDown(0.8);
            break;
          }
          case 'table': {
            const tb = t as Tokens.Table;
            const cols = tb.header.length;
            const cw = width / cols;
            const row = (cells: string[], bold: boolean) => {
              doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
              const h = Math.max(...cells.map((c) => doc.heightOfString(c, { width: cw - 8 }))) + 8;
              if (doc.y + h > doc.page.height - 56) doc.addPage();
              const y = doc.y;
              cells.forEach((c, i) => {
                doc.rect(56 + i * cw, y, cw, h).stroke('#d1d5db');
                doc.fillColor('#111827').text(c, 60 + i * cw, y + 4, { width: cw - 8 });
              });
              doc.x = 56;
              doc.y = y + h;
            };
            row(tb.header.map((h) => plain(h.text)), true);
            for (const r of tb.rows) row(r.map((c) => plain(c.text)), false);
            doc.moveDown(0.8);
            break;
          }
          case 'blockquote':
            doc.font('Helvetica-Oblique').fontSize(10.5).fillColor('#374151').text(plain((t as Tokens.Blockquote).text), { width, indent: 12 });
            doc.moveDown(0.5);
            break;
          case 'hr':
            doc.moveTo(56, doc.y).lineTo(56 + width, doc.y).stroke('#e5e7eb');
            doc.moveDown(0.6);
            break;
          case 'space':
            break;
          default:
            if ('text' in t && typeof t.text === 'string') {
              doc.font('Helvetica').fontSize(10.5).fillColor('#1f2937').text(plain(t.text), { width });
              doc.moveDown(0.4);
            }
        }
      }
    };
    write(marked.lexer(markdown));
    doc.end();
  });
}
