// AI 가 쓴 Markdown 을 Word(.docx) 파일로 바꾼다.
// 제목, 목록, 굵게, 인용, 표 정도의 업무 문서 서식만 다룬다.
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle,
} = require('docx');

/** "**굵게** 보통" → TextRun 목록 */
function runs(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun(text.slice(last, m.index)));
    if (m[1] != null) out.push(new TextRun({ text: m[1], bold: true }));
    else out.push(new TextRun({ text: m[2], font: 'Consolas' }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(new TextRun(text.slice(last)));
  return out.length ? out : [new TextRun('')];
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function table(lines) {
  const rows = lines.filter((l) => !isDivider(l)).map(cells);
  const cols = Math.max(...rows.map((r) => r.length));
  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r, i) => new TableRow({
      children: Array.from({ length: cols }, (_, c) => new TableCell({
        borders: { top: border, bottom: border, left: border, right: border },
        children: [new Paragraph({ children: i === 0 ? [new TextRun({ text: r[c] || '', bold: true })] : runs(r[c] || '') })],
      })),
    })),
  });
}

async function markdownToDocx(md, title) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const children = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableRow(line)) {
      const block = [];
      while (i < lines.length && isTableRow(lines[i])) block.push(lines[i++]);
      i--;
      children.push(table(block), new Paragraph(''));
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][m[1].length - 1];
      children.push(new Paragraph({ heading: level, children: runs(m[2]) }));
    } else if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) {
      children.push(new Paragraph({ bullet: { level: Math.min(Math.floor(m[1].length / 2), 3) }, children: runs(m[2]) }));
    } else if ((m = line.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      children.push(new Paragraph({ indent: { left: 360 + m[1].length * 180 }, children: [new TextRun(`${m[2]}. `), ...runs(m[3])] }));
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      children.push(new Paragraph({ indent: { left: 360 }, children: [new TextRun({ text: m[1], italics: true, color: '555555' })] }));
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } } }));
    } else if (line.trim()) {
      children.push(new Paragraph({ children: runs(line) }));
    } else {
      children.push(new Paragraph(''));
    }
  }
  const doc = new Document({
    title, creator: 'AI 업무 비서',
    styles: { default: { document: { run: { font: 'Malgun Gothic', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { markdownToDocx };
