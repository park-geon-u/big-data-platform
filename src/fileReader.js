// 업로드된 파일에서 AI 가 읽을 수 있는 내용을 뽑아낸다.
// 결과 kind:
//   text  — 텍스트로 추출 성공 (extracted_text 에 저장)
//   image — 이미지. AI 호출 시 원본을 비전 입력으로 전달
//   pdf   — 텍스트가 거의 없는 PDF(스캔본 등). AI 호출 시 PDF 원본을 문서 입력으로 전달
//   unsupported — 읽을 수 없는 형식
const path = require('path');
const JSZip = require('jszip');

const MAX_TEXT = 200_000; // 파일 하나당 저장할 최대 글자 수

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'swift', 'sql', 'sh', 'bat', 'ps1', 'css', 'scss', 'vue', 'svelte', 'r', 'tex', 'srt', 'vtt',
]);
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** 형식 목록 (화면 안내용) */
const SUPPORTED_LABEL = 'PDF, Word(.docx), Excel(.xlsx), PowerPoint(.pptx), 한글(.hwpx), HTML, 이미지(PNG·JPG·GIF·WEBP), 텍스트·CSV·JSON·코드 파일';

function extOf(name) { return path.extname(name).slice(1).toLowerCase(); }

/** UTF-8 이 깨지면 한국어 윈도우 인코딩(CP949/EUC-KR)으로 다시 읽는다. */
function decodeText(buf) {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.includes('�')) {
    try {
      const k = new TextDecoder('euc-kr', { fatal: true }).decode(buf);
      return k;
    } catch { /* utf8 로 둔다 */ }
  }
  return s;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function clip(text) {
  const t = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (t.length <= MAX_TEXT) return { text: t, note: null };
  return { text: t.slice(0, MAX_TEXT), note: `내용이 길어 앞부분 ${MAX_TEXT.toLocaleString()}자만 사용합니다.` };
}

function xmlText(xml, tag) {
  // <a:t>..</a:t>, <hp:t>..</hp:t> 같은 텍스트 노드를 모은다
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
const byNumber = (a, b) => (parseInt(a.match(/(\d+)/)?.[1] ?? 0) - parseInt(b.match(/(\d+)/)?.[1] ?? 0));

let pdfjsPromise = null;
async function readPdf(buf) {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  let doc;
  try {
    const base = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), '/');
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0,
      cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, // 한글 등 CJK 글꼴용
    }).promise;
  } catch (e) {
    if (e.name === 'PasswordException') return { kind: 'unsupported', note: '암호가 걸린 PDF 는 읽을 수 없습니다.' };
    // 텍스트 추출에 실패해도 AI 가 PDF 원본을 직접 볼 수 있다
    return { kind: 'pdf', text: null, note: 'PDF 텍스트 추출에 실패해 AI 가 원본 페이지를 직접 봅니다.' };
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const it of tc.items) {
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    pages.push(`--- ${i}쪽 ---\n${lines.join('\n')}`);
  }
  const n = doc.numPages;
  await doc.destroy();
  const body = pages.join('\n\n');
  const chars = body.replace(/--- \d+쪽 ---/g, '').replace(/\s/g, '').length;
  // 페이지당 글자가 너무 적으면 스캔본으로 보고 원본 PDF 를 AI 에 그대로 넘긴다
  if (chars < n * 10) {
    return { kind: 'pdf', text: null, note: `텍스트가 거의 없는 PDF(${n}쪽, 스캔본 추정)라 AI 가 원본 페이지를 직접 봅니다.` };
  }
  return { kind: 'text', ...clip(`[PDF, ${n}쪽]\n${body}`) };
}

async function readDocx(buf) {
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ buffer: buf });
  return { kind: 'text', ...clip(r.value) };
}

async function readXlsx(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c);
        let v = cell.text ?? '';
        if (v == null) v = '';
        v = String(v).replace(/\t|\n/g, ' ');
        vals.push(v);
      }
      rows.push(vals.join('\t'));
    });
    parts.push(`## 시트: ${ws.name} (${rows.length}행)\n${rows.join('\n')}`);
  });
  return { kind: 'text', ...clip(`[Excel, 탭으로 구분된 표]\n${parts.join('\n\n')}`) };
}

async function readPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
  const out = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name).async('string');
    const paras = xml.split(/<\/a:p>/).map((p) => xmlText(p, 'a:t').map(unescapeXml).join('')).filter(Boolean);
    const notesName = name.replace('slides/slide', 'notesSlides/notesSlide');
    let notes = '';
    if (zip.file(notesName)) {
      const nx = await zip.file(notesName).async('string');
      notes = nx.split(/<\/a:p>/).map((p) => xmlText(p, 'a:t').map(unescapeXml).join('')).filter(Boolean).join('\n');
    }
    out.push(`## 슬라이드 ${i + 1}\n${paras.join('\n')}${notes ? `\n(발표자 노트) ${notes}` : ''}`);
  }
  return { kind: 'text', ...clip(`[PowerPoint, ${slides.length}장]\n${out.join('\n\n')}`) };
}

async function readHwpx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const sections = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort(byNumber);
  const out = [];
  for (const name of sections) {
    const xml = await zip.file(name).async('string');
    const paras = xml.split(/<\/hp:p>/).map((p) => xmlText(p, 'hp:t').map(unescapeXml).join('')).filter(Boolean);
    out.push(paras.join('\n'));
  }
  return { kind: 'text', ...clip(`[한글 문서]\n${out.join('\n\n')}`) };
}

function readHtml(buf) {
  const html = decodeText(buf);
  const text = unescapeXml(html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' '));
  return { kind: 'text', ...clip(text) };
}

/**
 * @returns {Promise<{kind:string, text?:string|null, note?:string|null, mediaType?:string}>}
 */
async function extractFile(buf, originalName, mime = '') {
  const ext = extOf(originalName);
  try {
    if (ext === 'pdf' || mime === 'application/pdf') return await readPdf(buf);
    if (ext === 'docx') return await readDocx(buf);
    if (ext === 'xlsx' || ext === 'xlsm') return await readXlsx(buf);
    if (ext === 'pptx') return await readPptx(buf);
    if (ext === 'hwpx') return await readHwpx(buf);
    if (ext === 'html' || ext === 'htm') return readHtml(buf);
    if (IMAGE_MIME[ext]) return { kind: 'image', mediaType: IMAGE_MIME[ext], text: null, note: '이미지는 AI 가 직접 봅니다.' };
    if (ext === 'hwp') return { kind: 'unsupported', note: '구형 .hwp 는 지원하지 않습니다. 한글에서 .hwpx 또는 PDF 로 저장해 올려 주세요.' };
    if (ext === 'doc' || ext === 'xls' || ext === 'ppt') {
      return { kind: 'unsupported', note: `구형 .${ext} 형식은 지원하지 않습니다. .${ext}x 로 저장해 올려 주세요.` };
    }
    if (TEXT_EXT.has(ext) || mime.startsWith('text/') || !looksBinary(buf)) {
      return { kind: 'text', ...clip(decodeText(buf)) };
    }
    return { kind: 'unsupported', note: '읽을 수 없는 형식입니다. 파일은 저장되지만 AI 가 내용을 참고하지 못합니다.' };
  } catch (e) {
    return { kind: 'unsupported', note: `파일을 읽는 중 오류가 났습니다: ${e.message}` };
  }
}

module.exports = { extractFile, SUPPORTED_LABEL, IMAGE_MIME };
