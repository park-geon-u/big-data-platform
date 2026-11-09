// 개인 키가 없는 사용자는 서버의 무료 기본 AI 를 하루 정해진 횟수만 쓸 수 있다
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

let server, base, tmp, db;
const calls = [];
let fail = false;
const fakeAI = async (history, files, opts) => {
  calls.push(opts);
  if (fail) { const e = new Error('Gemini 과부하'); throw e; }
  return '답변';
};
const FREE_KEY = 'AQ.free-server-key-123456';
const OWN_KEY = 'AIza' + 'm'.repeat(35);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-'));
  const r = createApp({
    dbFile: path.join(tmp, 't.db'), uploadDir: path.join(tmp, 'up'), generateReply: fakeAI,
    generateDocument: async () => '# 문서', listModels: async () => ['gemini-3.5-flash'],
    freeAI: { apiKey: FREE_KEY, provider: 'google', model: 'gemini-3.5-flash', dailyLimit: 5 },
  });
  db = r.db;
  server = r.app.listen(0);
  await new Promise((ok) => server.once('listening', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function user(email) {
  const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email, password: 'password1' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
}

test('키 없는 사용자: 무료 기본 AI 하루 5회, 실패는 횟수에서 제외, 키 등록하면 제한 없음', async () => {
  const U = await user('u@x.com');
  const V = await user('v@x.com');
  let me = (await U('GET', '/api/me/ai')).body;
  assert.deepEqual([me.freeAI.enabled, me.freeAI.limit, me.freeAI.remaining, me.freeAI.inUse], [true, 5, 5, true]);
  assert.ok(!JSON.stringify(me).includes(FREE_KEY)); // 서버 키는 화면에 절대 안 나감

  const c = (await U('POST', '/api/conversations', {})).body;
  for (let i = 0; i < 4; i++) assert.equal((await U('POST', `/api/conversations/${c.id}/messages`, { content: `질문 ${i}` })).status, 200);
  assert.deepEqual([calls.at(-1).apiKey, calls.at(-1).provider, calls.at(-1).model], [FREE_KEY, 'google', 'gemini-3.5-flash']);
  // AI 실패는 횟수를 쓰지 않는다
  fail = true;
  await U('POST', `/api/conversations/${c.id}/messages`, { content: '실패할 질문' });
  fail = false;
  assert.equal((await U('GET', '/api/me/ai')).body.freeAI.remaining, 1);
  // 5번째는 문서 생성으로 사용
  assert.equal((await U('POST', `/api/conversations/${c.id}/documents`, { instruction: '정리' })).status, 200);
  // 6번째부터 거부 (메시지도 저장되지 않음)
  const before6 = (await U('GET', `/api/conversations/${c.id}`)).body.messages.length;
  const r6 = await U('POST', `/api/conversations/${c.id}/messages`, { content: '6번째' });
  assert.equal(r6.status, 429);
  assert.match(r6.body.error, /5회/);
  assert.equal((await U('GET', `/api/conversations/${c.id}`)).body.messages.length, before6);
  assert.equal((await U('POST', `/api/conversations/${c.id}/documents`, { instruction: '또' })).status, 429);
  assert.equal((await U('GET', '/api/me/ai')).body.freeAI.remaining, 0);

  // 다른 사용자는 따로 센다
  const cv = (await V('POST', '/api/conversations', {})).body;
  assert.equal((await V('POST', `/api/conversations/${cv.id}/messages`, { content: '안녕' })).status, 200);
  assert.equal((await V('GET', '/api/me/ai')).body.freeAI.remaining, 4);

  // 개인 키를 등록하면 그 키로, 제한 없이
  await U('PUT', '/api/me/ai/keys/google', { apiKey: OWN_KEY });
  me = (await U('GET', '/api/me/ai')).body;
  assert.equal(me.freeAI.inUse, false);
  assert.equal((await U('POST', `/api/conversations/${c.id}/messages`, { content: '내 키로' })).status, 200);
  assert.equal(calls.at(-1).apiKey, OWN_KEY);
  // 다음 날이 되면 다시 5회 (날짜 기록을 하루 전으로 옮겨 확인)
  db.prepare("UPDATE free_ai_usage SET day = '2000-01-01'").run();
  assert.equal((await V('GET', '/api/me/ai')).body.freeAI.remaining, 5);
});
