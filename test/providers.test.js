// 각 AI 제공자에 보내는 요청 형식을 확인한다 (실제 네트워크 없이)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ai = require('../src/ai');

const fx = (n) => path.join(__dirname, 'fixtures', n);
const files = [
  { name: 'report.docx', kind: 'text', extracted_text: '매출 1,200만원' },
  { name: 'pic.png', kind: 'image', mime: 'image/png', size: 581, storage_path: fx('pic.png') },
  { name: 'scan.pdf', kind: 'pdf', mime: 'application/pdf', size: 1326, storage_path: fx('scan.pdf') },
];
const history = [{ role: 'user', content: '첫 질문' }, { role: 'assistant', content: '첫 답' }, { role: 'user', content: '요약해 줘' }];

function capture(reply) {
  const calls = [];
  ai.setFetch(async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body && JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return calls;
}

test('Claude 요청 형식', async () => {
  const calls = capture({ content: [{ type: 'text', text: '클로드 답' }] });
  const r = await ai.generateReply(history, files, { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k1' });
  assert.equal(r, '클로드 답');
  const { url, headers, body } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'k1');
  const last = body.messages.at(-1).content;
  assert.ok(last.some((b) => b.type === 'image' && b.source.media_type === 'image/png'));
  assert.ok(last.some((b) => b.type === 'document' && b.source.media_type === 'application/pdf'));
  assert.ok(last.some((b) => b.type === 'text' && b.text.includes('매출 1,200만원')));
  assert.equal(last.at(-1).text, '요약해 줘');
});

test('GPT 요청 형식', async () => {
  const calls = capture({ choices: [{ message: { content: 'GPT 답' } }] });
  const r = await ai.generateReply(history, files, { provider: 'openai', model: 'gpt-5', apiKey: 'k2' });
  assert.equal(r, 'GPT 답');
  const { url, headers, body } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers.authorization, 'Bearer k2');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[2].content, '첫 답');
  const last = body.messages.at(-1).content;
  assert.ok(last.some((b) => b.type === 'image_url' && b.image_url.url.startsWith('data:image/png;base64,')));
  assert.ok(last.some((b) => b.type === 'file' && b.file.file_data.startsWith('data:application/pdf;base64,')));
});

test('Gemini 요청 형식', async () => {
  const calls = capture({ candidates: [{ content: { parts: [{ text: '제미나이 ' }, { text: '답' }] } }] });
  const r = await ai.generateReply(history, files, { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k3' });
  assert.equal(r, '제미나이 답');
  const { url, headers, body } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(headers['x-goog-api-key'], 'k3');
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
  const parts = body.contents.at(-1).parts;
  assert.ok(parts.some((p) => p.inline_data?.mime_type === 'image/png'));
  assert.ok(parts.some((p) => p.inline_data?.mime_type === 'application/pdf'));
});

test('오류는 알아듣기 쉬운 말로, 모델 목록은 걸러서', async () => {
  ai.setFetch(async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 }));
  await assert.rejects(ai.generateReply(history, [], { provider: 'openai', model: 'gpt-5', apiKey: 'bad' }), /GPT \(OpenAI\) API 키가 올바르지 않습니다/);
  ai.setFetch(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'whisper-1' }, { id: 'gpt-4o-realtime-preview' }, { id: 'text-embedding-3-small' }] }), { status: 200 }));
  assert.deepEqual(await ai.listModels('openai', 'k'), ['gpt-5']);
  ai.setFetch(async () => new Response(JSON.stringify({ models: [
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ] }), { status: 200 }));
  assert.deepEqual(await ai.listModels('google', 'k'), ['gemini-2.5-flash']);
  // 키가 없으면 데모 응답
  assert.match(await ai.generateReply(history, [], { provider: 'google' }), /데모 응답/);
});
