// 여러 AI 제공자(Claude, GPT, Gemini)를 같은 방식으로 부른다.
// 각 사용자가 자기 API 키를 넣고, 질문할 때 그 사람의 키와 모델로 호출한다.
// 키가 없으면 데모용 모의 응답을 돌려준다.
const fs = require('fs');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

const SYSTEM = `당신은 사용자의 업무를 돕는 AI 비서입니다. 한국어로 명확하고 간결하게 답하세요.
사용자가 첨부한 파일이 <file> 태그나 이미지·PDF 로 주어지면 그 내용을 근거로 답하고, 어느 파일을 참고했는지 밝히세요.
주어진 자료에 없는 내용은 추측이라고 분명히 말하세요.`;

/** 제공자 정보. 화면 안내와 키 형식 검사에 쓴다. */
const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)', keyPrefix: 'sk-ant-', keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5-5', fallbackModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  },
  openai: {
    label: 'GPT (OpenAI)', keyPrefix: 'sk-', keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5', fallbackModels: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
  },
  codex: {
    label: 'Codex (OpenAI)', keyOf: 'openai', keyPrefix: 'sk-', keyUrl: 'https://platform.openai.com/api-keys',
    note: 'OpenAI 의 코딩 특화 모델입니다. GPT 칸에 넣은 OpenAI 키를 함께 씁니다.',
    defaultModel: 'gpt-5-codex', fallbackModels: ['gpt-5-codex', 'codex-mini-latest'],
  },
  google: {
    label: 'Gemini (Google)', keyPrefix: ['AIza', 'AQ.'], keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.5-flash', fallbackModels: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-pro-latest', 'gemini-flash-latest'],
  },
};

class AIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// 테스트에서 바꿔 끼울 수 있게 fetch 를 감싼다
let fetchImpl = (...a) => fetch(...a);
function setFetch(fn) { fetchImpl = fn; }

async function http(url, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method, signal: ctrl.signal,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new AIError(e.name === 'AbortError' ? 'AI 응답 시간이 초과되었습니다.' : `AI 서버에 연결하지 못했습니다: ${e.message}`, 0);
  } finally { clearTimeout(t); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || data?.raw?.slice(0, 200) || res.statusText;
    throw new AIError(msg, res.status);
  }
  return data;
}

/** 오류를 사용자가 이해할 수 있는 말로 */
function friendlyError(provider, e) {
  const name = PROVIDERS[provider]?.label || provider;
  const s = e.status;
  if (s === 401 || (s === 400 && /api key|API_KEY_INVALID/i.test(e.message))) return `${name} API 키가 올바르지 않습니다.`;
  if (s === 403) return `${name}: 이 키로는 권한이 없습니다. (${e.message})`;
  if (s === 404) return `${name}: 이 키로 선택한 모델을 쓸 수 없습니다. ⚙ 내 AI 설정에서 다른 모델을 골라 주세요. (${e.message.slice(0, 160)})`;
  if (s === 503 || s === 529) return `${name}: 지금 사용자가 많아 잠시 응답하지 못합니다. 조금 뒤 다시 시도하거나 다른 모델을 골라 주세요.`;
  if (s === 429) return `${name}: 사용 한도를 넘었거나 크레딧이 부족합니다. (${e.message})`;
  return `${name} 오류: ${e.message}`;
}

// ---------------- 파일 → 입력 변환 ----------------
const readB64 = (f) => fs.readFileSync(f.storage_path).toString('base64');
const fileHeader = (f) => `<file name="${f.name.replace(/"/g, "'")}">`;
/** 공통 중간 형태: {type:'text', text} | {type:'image', mime, data, name} | {type:'pdf', data, name} */
function fileParts(f) {
  if (f.kind === 'text') return [{ type: 'text', text: `${fileHeader(f)}\n${f.extracted_text || ''}\n</file>` }];
  if (f.kind === 'image') {
    if (f.size > MAX_IMAGE_BYTES) return [{ type: 'text', text: `${fileHeader(f)}(이미지가 5MB 를 넘어 볼 수 없음)</file>` }];
    return [{ type: 'text', text: `다음 이미지는 첨부 파일 "${f.name}" 입니다.` }, { type: 'image', mime: f.mime, data: readB64(f), name: f.name }];
  }
  if (f.kind === 'pdf') {
    if (f.size > MAX_PDF_BYTES) return [{ type: 'text', text: `${fileHeader(f)}(PDF 가 20MB 를 넘어 볼 수 없음)</file>` }];
    return [{ type: 'text', text: `다음 PDF 는 첨부 파일 "${f.name}" 입니다.` }, { type: 'pdf', data: readB64(f), name: f.name }];
  }
  return [{ type: 'text', text: `${fileHeader(f)}(이 형식은 읽을 수 없음: ${f.extract_note || ''})</file>` }];
}

/** 대화 기록을 [{role:'user'|'assistant', parts:[...]}] 로 정리 (같은 role 연속은 합침, 파일은 마지막 질문 앞에) */
function buildTurns(history, files, multiUser) {
  const turns = [];
  for (const m of history) {
    const text = m.role === 'user' && multiUser ? `[${m.author_name}] ${m.content}` : m.content;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.parts.push({ type: 'text', text });
    else turns.push({ role: m.role, parts: [{ type: 'text', text }] });
  }
  if (files.length && turns.length) {
    const last = turns[turns.length - 1];
    last.parts = [...files.flatMap(fileParts), ...last.parts];
  }
  return turns;
}

// ---------------- 제공자별 구현 ----------------
const adapters = {
  anthropic: {
    async chat(key, model, turns, system = SYSTEM) {
      const messages = turns.map((t) => ({
        role: t.role,
        content: t.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text }
          : p.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
            : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data }, title: p.name })),
      }));
      const r = await http('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: 8192, system, messages },
      });
      return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    },
    async models(key) {
      const r = await http('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      return (r.data || []).map((m) => m.id);
    },
  },

  openai: {
    async chat(key, model, turns, system = SYSTEM) {
      const messages = [{ role: 'system', content: system }, ...turns.map((t) => ({
        role: t.role,
        content: t.role === 'assistant' ? t.parts.map((p) => p.text).join('\n\n') : t.parts.map((p) => (
          p.type === 'text' ? { type: 'text', text: p.text }
            : p.type === 'image' ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }
              : { type: 'file', file: { filename: p.name, file_data: `data:application/pdf;base64,${p.data}` } })),
      }))];
      const r = await http('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${key}` },
        body: { model, messages, max_completion_tokens: 8192 },
      });
      return r.choices?.[0]?.message?.content || '';
    },
    async models(key) {
      const r = await http('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
      return (r.data || []).map((m) => m.id)
        .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|instruct|codex)/.test(id))
        .sort().reverse();
    },
  },

  // Codex 모델은 Chat Completions 가 아니라 Responses API 로만 부를 수 있다
  codex: {
    async chat(key, model, turns, system = SYSTEM) {
      const input = turns.map((t) => ({
        role: t.role,
        content: t.role === 'assistant'
          ? [{ type: 'output_text', text: t.parts.map((p) => p.text).join('\n\n') }]
          : t.parts.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text }
            : p.type === 'image' ? { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` }
              : { type: 'input_file', filename: p.name, file_data: `data:application/pdf;base64,${p.data}` })),
      }));
      const r = await http('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { authorization: `Bearer ${key}` },
        body: { model, instructions: system, input, max_output_tokens: 8192 },
      });
      if (typeof r.output_text === 'string') return r.output_text;
      return (r.output || []).filter((o) => o.type === 'message')
        .flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    },
    async models(key) {
      const r = await http('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
      return (r.data || []).map((m) => m.id).filter((id) => id.includes('codex')).sort().reverse();
    },
  },

  google: {
    async chat(key, model, turns, system = SYSTEM) {
      const contents = turns.map((t) => ({
        role: t.role === 'assistant' ? 'model' : 'user',
        parts: t.parts.map((p) => (p.type === 'text' ? { text: p.text }
          : { inline_data: { mime_type: p.type === 'pdf' ? 'application/pdf' : p.mime, data: p.data } })),
      }));
      const r = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': key },
        body: { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: 8192 } },
      });
      const c = r.candidates?.[0];
      const text = (c?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text && r.promptFeedback?.blockReason) return `(Gemini 가 답변을 거부했습니다: ${r.promptFeedback.blockReason})`;
      return text;
    },
    async models(key) {
      const r = await http('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
      return (r.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((id) => id.startsWith('gemini') && !/(embedding|tts|image|audio|live|robotics|banana|transcribe|computer-use|customtools)/.test(id))
        .sort().reverse();
    },
  },
};

/** 키가 실제로 동작하는지 확인 + 쓸 수 있는 모델 목록 */
async function listModels(provider, key) {
  try {
    const list = await adapters[provider].models(key);
    return list.length ? list : PROVIDERS[provider].fallbackModels;
  } catch (e) {
    throw new AIError(friendlyError(provider, e), e.status);
  }
}

/**
 * @param history [{role, content, author_name}]  시간순 메시지 (마지막은 user)
 * @param files   대화에 붙은 파일 행 (권한 검사를 통과한 것만)
 * @param opts {provider, model, apiKey, multiUser}
 */
async function generateReply(history, files, opts = {}) {
  const { provider = 'anthropic', model, apiKey, multiUser } = opts;
  if (!apiKey) return opts.mock ? opts.mock(history, files, provider) : mockReply(history, files, provider);
  const turns = buildTurns(history, files, multiUser);
  try {
    const text = await adapters[provider].chat(apiKey, model || PROVIDERS[provider].defaultModel, turns, opts.system || SYSTEM);
    return text.trim() || '(빈 응답)';
  } catch (e) {
    throw new AIError(friendlyError(provider, e), e.status);
  }
}

// ---------------- 3차: AI 문서 생성 ----------------
const DOC_SYSTEM = `당신은 업무 문서를 작성하는 AI 비서입니다.
지금까지의 대화와 첨부 파일만 근거로, 사용자가 요청한 문서를 한국어 Markdown 으로 작성하세요.
- 첫 줄은 "# 문서 제목" 으로 시작합니다.
- 제목(##), 목록(-, 1.), 굵게(**), 표(| |)를 적절히 씁니다.
- 대화나 파일에 없는 사실은 지어내지 말고, 필요하면 "확인 필요" 라고 적습니다.
- 문서 본문만 출력하고, 앞뒤 인사말이나 설명은 쓰지 않습니다.`;

/**
 * 대화 기록 + 파일로 문서를 만든다. 결과는 Markdown 문자열.
 * @param instruction 사용자가 원하는 문서 (예: "회의록으로 정리")
 */
async function generateDocument(history, files, instruction, opts = {}) {
  const transcript = history.map((m) => `${m.role === 'assistant' ? 'AI' : (m.author_name || '사용자')}: ${m.content}`).join('\n\n');
  const ask = `다음은 지금까지의 대화입니다.\n<conversation>\n${transcript || '(대화 없음)'}\n</conversation>\n\n요청한 문서: ${instruction}`;
  const md = await generateReply([{ role: 'user', content: ask }], files, {
    ...opts, multiUser: false, system: DOC_SYSTEM,
    mock: () => mockDocument(history, files, instruction),
  });
  // 모델이 코드 블록으로 감싸 보내는 경우 벗겨낸다
  return md.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
}

function mockDocument(history, files, instruction) {
  return [
    `# ${instruction.slice(0, 50)}`,
    '',
    '> ⚠️ AI 키가 없어 데모 문서입니다. ⚙ 내 AI 설정에서 키를 넣으면 AI 가 실제 내용을 작성합니다.',
    '',
    '## 대화 요약',
    ...history.slice(-10).map((m) => `- **${m.role === 'assistant' ? 'AI' : (m.author_name || '사용자')}**: ${m.content.replace(/\s+/g, ' ').slice(0, 100)}`),
    '',
    '## 참고한 파일',
    ...(files.length ? files.map((f) => `- ${f.name}`) : ['- (없음)']),
  ].join('\n');
}

function mockReply(history, files, provider) {
  const q = history[history.length - 1]?.content || '';
  const lines = [
    `⚠️ ${PROVIDERS[provider]?.label || 'AI'} API 키가 없어 데모 응답을 보여 드립니다. 왼쪽 아래 [⚙ 내 AI 설정]에서 내 키를 넣으면 실제 AI 가 답합니다.`,
    '',
    `질문: "${q.slice(0, 200)}"`,
  ];
  if (files.length) {
    lines.push('', '참고한 파일:');
    for (const f of files) {
      const preview = f.kind === 'text' ? ` — "${(f.extracted_text || '').slice(0, 80).replace(/\s+/g, ' ')}…"`
        : f.kind === 'image' ? ' — 이미지(AI 에 그림으로 전달)'
          : f.kind === 'pdf' ? ' — PDF 원본(AI 에 문서로 전달)' : ' — 읽을 수 없음';
      lines.push(`- ${f.name}${preview}`);
    }
  }
  return lines.join('\n');
}

module.exports = { PROVIDERS, generateReply, generateDocument, listModels, setFetch, AIError, buildTurns, adapters };
