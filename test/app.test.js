// 서버 권한 검사와 파일 읽기를 실제 HTTP 로 확인한다.  실행: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

let server, base, tmp, db;
const seen = []; // AI 에 전달된 파일 기록
let lastOpts = null;
const fakeAI = async (history, files, opts) => { lastOpts = opts; seen.push(files.map((f) => f.name)); return `답변(${files.length}개 파일)`; };
const GOOD = { anthropic: 'sk-ant-api03-' + 'a'.repeat(40) + 'WXYZ', openai: 'sk-proj-' + 'o'.repeat(40) + 'OPEN', google: 'AIza' + 'g'.repeat(35) };
let docCall = null;
const fakeDoc = async (history, files, instruction, opts) => {
  docCall = { history, files: files.map((f) => f.name), instruction, opts };
  return `# 주간 회의록\n\n## 요약\n- **매출** 증가\n\n| 항목 | 값 |\n|---|---|\n| 매출 | 150 |`;
};
const fakeList = async (provider, key) => {
  if (key !== GOOD[provider]) throw new Error(`${provider} API 키가 올바르지 않습니다.`);
  return { anthropic: ['claude-sonnet-5-5'], openai: ['gpt-5', 'gpt-5-mini'], google: ['gemini-2.5-flash'] }[provider];
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiapp-'));
  const r = createApp({ dbFile: path.join(tmp, 't.db'), uploadDir: path.join(tmp, 'up'), generateReply: fakeAI, listModels: fakeList, generateDocument: fakeDoc });
  db = r.db;
  server = r.app.listen(0);
  await new Promise((ok) => server.once('listening', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = cookie ? { cookie } : {};
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return {
    raw: call,
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}),
    patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u),
    upload: (fixture, extra = {}) => {
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', fixture))]), fixture);
      for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
      return call('POST', '/api/files', fd);
    },
  };
}

let A, B;
test('회원가입 / 로그인 / 비로그인 차단', async () => {
  A = client(); B = client();
  assert.equal((await A.post('/api/auth/signup', { email: 'a@x.com', name: 'A', password: 'password1' })).status, 200);
  assert.equal((await B.post('/api/auth/signup', { email: 'b@x.com', name: 'B', password: 'password2' })).status, 200);
  assert.equal((await A.post('/api/auth/signup', { email: 'A@x.com', name: 'A2', password: 'password1' })).status, 409);
  assert.equal((await client().get('/api/conversations')).status, 401);
  const bad = client();
  assert.equal((await bad.post('/api/auth/login', { email: 'a@x.com', password: 'wrong-pass' })).status, 401);
  assert.equal((await bad.post('/api/auth/login', { email: 'a@x.com', password: 'password1' })).status, 200);
  const stored = db.prepare("SELECT password_hash FROM users WHERE email='a@x.com'").get().password_hash;
  assert.ok(!stored.includes('password1'));
});

test('개인 AI 대화는 사용자별로 격리된다', async () => {
  const c = (await A.post('/api/conversations')).body;
  const r = await A.post(`/api/conversations/${c.id}/messages`, { content: '안녕' });
  assert.equal(r.status, 200);
  assert.equal(r.body.messages.length, 2);
  assert.equal(r.body.messages[1].role, 'assistant');
  // B 는 목록에서도, 직접 API 호출로도 볼 수 없다
  assert.equal((await B.get('/api/conversations')).body.conversations.length, 0);
  assert.equal((await B.get(`/api/conversations/${c.id}`)).status, 404);
  assert.equal((await B.post(`/api/conversations/${c.id}/messages`, { content: '몰래' })).status, 404);
  assert.equal((await B.del(`/api/conversations/${c.id}`)).status, 404);
});

test('다양한 형식의 파일을 AI 가 읽는다', async () => {
  const c = (await A.post('/api/conversations')).body;
  const cases = {
    'report.docx': ['text', '1,200만원'], 'sales.xlsx': ['text', '2월\t150'], 'plan.pptx': ['text', '신규 고객 30%'],
    'doc.pdf': ['text', 'supplier delays'], 'report-ko.pdf': ['text', '주간 보고서'], 'scan.pdf': ['pdf', null],
    'memo.hwpx': ['text', '예산 승인 & 일정'], 'euckr.csv': ['text', '홍길동'], 'note.md': ['text', '보고서 작성'],
    'pic.png': ['image', null], 'bin.dat': ['unsupported', null],
  };
  for (const [name, [kind, needle]] of Object.entries(cases)) {
    const r = await A.upload(name, { conversationId: c.id });
    assert.equal(r.status, 200, name);
    assert.equal(r.body.file.kind, kind, name);
    assert.equal(r.body.file.name, name);
    if (needle) {
      const d = await A.get(`/api/files/${r.body.file.id}`);
      assert.ok(d.body.preview.includes(needle), `${name}: ${d.body.preview}`);
    }
  }
  seen.length = 0;
  await A.post(`/api/conversations/${c.id}/messages`, { content: '요약해 줘' });
  assert.equal(seen[0].length, Object.keys(cases).length);
});

test('한글 파일 이름이 깨지지 않는다', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['내용']), '회의록 최종.txt');
  const r = await A.raw('POST', '/api/files', fd);
  assert.equal(r.body.file.name, '회의록 최종.txt');
});

let P, aPrivFile, aSharedFile, thread;
test('프로젝트·스레드·파일: 다른 사람에게 자동으로 보이지 않는다', async () => {
  P = (await A.post('/api/projects', { name: '프로젝트 X' })).body;
  assert.equal(P.role, 'owner');
  thread = (await A.post(`/api/projects/${P.id}/threads`)).body;
  aPrivFile = (await A.upload('report.docx', { projectId: P.id })).body.file;
  aSharedFile = (await A.upload('sales.xlsx', { projectId: P.id, visibility: 'project' })).body.file;
  assert.equal(aPrivFile.visibility, 'private');
  assert.equal(aSharedFile.visibility, 'project');

  // B 는 멤버가 아니므로 전부 404
  assert.equal((await B.get(`/api/projects/${P.id}`)).status, 404);
  assert.equal((await B.get(`/api/conversations/${thread.id}`)).status, 404);
  assert.equal((await B.get(`/api/files/${aSharedFile.id}`)).status, 404);
  assert.equal((await B.get(`/api/files/${aSharedFile.id}/download`)).status, 404);
  assert.equal((await B.upload('note.md', { projectId: P.id })).status, 404);
  assert.equal((await B.post(`/api/projects/${P.id}/threads`)).status, 404);
  assert.equal((await B.patch(`/api/files/${aPrivFile.id}`, { visibility: 'project' })).status, 404);
  assert.equal((await B.del(`/api/projects/${P.id}`)).status, 404);

  // B 를 멤버로 넣어도 (2차 초대 기능 대신 DB 로) A 의 비공개 스레드·파일은 안 보인다
  db.prepare("INSERT INTO project_members VALUES (?, (SELECT id FROM users WHERE email='b@x.com'), 'member')").run(P.id);
  const pv = await B.get(`/api/projects/${P.id}`);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.threads.length, 0);
  assert.deepEqual(pv.body.files.map((f) => f.id), [aSharedFile.id]);
  assert.equal((await B.get(`/api/conversations/${thread.id}`)).status, 404);
  assert.equal((await B.get(`/api/files/${aPrivFile.id}`)).status, 404);
  assert.equal((await B.get(`/api/files/${aSharedFile.id}`)).status, 200);
  // 멤버라도 소유자 전용 작업은 403
  assert.equal((await B.del(`/api/projects/${P.id}`)).status, 403);
  assert.equal((await B.del(`/api/files/${aSharedFile.id}`)).status, 403);
});

test('대화에 붙일 수 있는 파일 범위가 서버에서 검사된다', async () => {
  const personal = (await B.post('/api/conversations')).body;
  // B 가 A 의 공개 프로젝트 파일을 자기 개인 대화에 붙일 수 없다 (개인 대화 = 개인 파일만)
  assert.equal((await B.post(`/api/conversations/${personal.id}/files`, { fileId: aSharedFile.id })).status, 403);
  // 다른 프로젝트 파일을 스레드에 붙일 수 없다
  const bFile = (await B.upload('note.md')).body.file;
  assert.equal((await A.post(`/api/conversations/${thread.id}/files`, { fileId: bFile.id })).status, 404);
  assert.equal((await A.post(`/api/conversations/${thread.id}/files`, { fileId: aPrivFile.id })).status, 200);
});

test('스레드 공유: 읽기 권한은 열람만, 공유 대화에서 AI 는 모두가 볼 수 있는 파일만 쓴다', async () => {
  const bId = db.prepare("SELECT id FROM users WHERE email='b@x.com'").get().id;
  db.prepare("INSERT INTO thread_members VALUES (?, ?, 'read')").run(thread.id, bId);
  assert.equal((await B.get(`/api/conversations/${thread.id}`)).status, 200);
  assert.equal((await B.post(`/api/conversations/${thread.id}/messages`, { content: '질문' })).status, 403);
  // A 의 비공개 파일은 B 가 볼 수 없으므로 공유된 스레드에서 AI 입력에서 빠진다
  seen.length = 0;
  await A.post(`/api/conversations/${thread.id}/messages`, { content: '파일 봐 줘' });
  assert.deepEqual(seen[0], []);
  assert.equal((await A.post(`/api/conversations/${thread.id}/files`, { fileId: aPrivFile.id })).status, 403);
  assert.equal((await A.post(`/api/conversations/${thread.id}/files`, { fileId: aSharedFile.id })).status, 200);
  db.prepare("UPDATE thread_members SET permission='participate' WHERE conversation_id=?").run(thread.id);
  seen.length = 0;
  const r = await B.post(`/api/conversations/${thread.id}/messages`, { content: 'B 의 질문' });
  assert.equal(r.status, 200);
  assert.deepEqual(seen[0], ['sales.xlsx']);
  // 권한 회수 후 즉시 차단
  db.prepare('DELETE FROM thread_members WHERE conversation_id=?').run(thread.id);
  assert.equal((await B.get(`/api/conversations/${thread.id}`)).status, 404);
});

test('사용자마다 자기 AI 키(Claude·GPT·Gemini)를 따로 쓴다', async () => {
  // 처음엔 키 없음 → 데모
  let me = (await A.get('/api/me/ai')).body;
  assert.equal(me.active.hasKey, false);
  assert.deepEqual(me.providers.map((p) => p.id), ['anthropic', 'openai', 'codex', 'google']);
  // 잘못된 키·다른 회사 키·없는 제공자는 거절
  assert.equal((await A.raw('PUT', '/api/me/ai/keys/openai', { apiKey: 'sk-wrong' + 'x'.repeat(30) })).status, 400);
  const mismatch = await A.raw('PUT', '/api/me/ai/keys/google', { apiKey: GOOD.openai });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.error, /AIza/);
  // 구글의 새 형식 키(AQ.)는 앞부분 검사에서 막히지 않고 실제 서버 확인으로 넘어간다
  const aq = await A.raw('PUT', '/api/me/ai/keys/google', { apiKey: 'AQ.' + 'q'.repeat(40) });
  assert.doesNotMatch(aq.body.error, /시작합니다/);
  assert.equal((await A.raw('PUT', '/api/me/ai/keys/llama', { apiKey: 'x' })).status, 400);
  // A 는 GPT 키, B 는 Gemini 키
  const ra = await A.raw('PUT', '/api/me/ai/keys/openai', { apiKey: GOOD.openai });
  assert.equal(ra.status, 200);
  assert.deepEqual(ra.body.models, ['gpt-5', 'gpt-5-mini']);
  assert.equal(ra.body.active.provider, 'openai'); // 첫 키는 바로 사용
  assert.ok(!JSON.stringify(ra.body).includes(GOOD.openai));
  assert.equal((await B.raw('PUT', '/api/me/ai/keys/google', { apiKey: GOOD.google })).status, 200);
  // 서로의 키 정보는 보이지 않는다
  const bView = (await B.get('/api/me/ai')).body;
  assert.equal(bView.providers.find((p) => p.id === 'openai').hasKey, false);
  assert.equal(bView.providers.find((p) => p.id === 'google').hasKey, true);
  // DB 에 평문 키가 없다
  const raws = db.prepare('SELECT enc_key FROM user_api_keys').all().map((r) => r.enc_key).join();
  assert.ok(!raws.includes(GOOD.openai) && !raws.includes(GOOD.google));
  // 모델 바꾸기
  assert.equal((await A.raw('PUT', '/api/me/ai/active', { provider: 'openai', model: 'gpt-5-mini' })).body.active.model, 'gpt-5-mini');
  assert.equal((await A.raw('PUT', '/api/me/ai/active', { provider: 'openai', model: 'bad model!' })).status, 400);
  // 질문할 때 본인 키·AI 가 쓰인다
  const ca = (await A.post('/api/conversations')).body;
  const ans = await A.post(`/api/conversations/${ca.id}/messages`, { content: '안녕' });
  assert.deepEqual([lastOpts.provider, lastOpts.model, lastOpts.apiKey], ['openai', 'gpt-5-mini', GOOD.openai]);
  assert.equal(ans.body.messages[1].aiModel, 'gpt-5-mini');
  const cb = (await B.post('/api/conversations')).body;
  await B.post(`/api/conversations/${cb.id}/messages`, { content: '안녕' });
  assert.deepEqual([lastOpts.provider, lastOpts.apiKey], ['google', GOOD.google]);
  // Codex 는 OpenAI 키를 함께 쓴다 (따로 키를 넣지 않음)
  assert.equal((await A.raw('PUT', '/api/me/ai/keys/codex', { apiKey: GOOD.openai })).status, 400);
  const cx = await A.raw('PUT', '/api/me/ai/active', { provider: 'codex', model: 'gpt-5-codex' });
  assert.equal(cx.body.providers.find((p) => p.id === 'codex').hasKey, true);
  await A.post(`/api/conversations/${ca.id}/messages`, { content: '코드 봐 줘' });
  assert.deepEqual([lastOpts.provider, lastOpts.model, lastOpts.apiKey], ['codex', 'gpt-5-codex', GOOD.openai]);
  // GPT 쪽 모델 선택은 그대로 유지
  assert.equal(cx.body.providers.find((p) => p.id === 'openai').model, 'gpt-5-mini');
  assert.equal((await B.get('/api/me/ai')).body.providers.find((p) => p.id === 'codex').hasKey, false);
  // 키 삭제 → 다음 질문은 키 없이 (데모)
  await A.del('/api/me/ai/keys/openai');
  await A.post(`/api/conversations/${ca.id}/messages`, { content: '또' });
  assert.equal(lastOpts.apiKey, null);
  assert.equal((await client().get('/api/me/ai')).status, 401);
});

test('2차: 초대 → 수락, 파일 개별 공유, 스레드 공유, 내보내면 즉시 차단', async () => {
  const C = client(); const D = client();
  await C.post('/api/auth/signup', { email: 'c@x.com', name: 'C', password: 'password3' });
  await D.post('/api/auth/signup', { email: 'd@x.com', name: 'D', password: 'password4' });
  const cId = db.prepare("SELECT id FROM users WHERE email='c@x.com'").get().id;
  const dId = db.prepare("SELECT id FROM users WHERE email='d@x.com'").get().id;
  const Q = (await A.post('/api/projects', { name: '프로젝트 Q' })).body;

  // 초대: 소유자만, 가입자만
  assert.equal((await A.post(`/api/projects/${Q.id}/invites`, { email: 'nobody@x.com' })).status, 404);
  assert.equal((await C.post(`/api/projects/${Q.id}/invites`, { email: 'd@x.com' })).status, 404); // 멤버가 아니면 존재도 모름
  const inv = await A.post(`/api/projects/${Q.id}/invites`, { email: 'C@x.com' });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.invites.length, 1);
  // 초대만으로는 멤버가 아니다
  assert.equal((await C.get(`/api/projects/${Q.id}`)).status, 404);
  const cInv = (await C.get('/api/invites')).body.invites;
  assert.equal(cInv[0].projectName, '프로젝트 Q');
  // D 가 C 의 초대를 대신 수락할 수 없다
  assert.equal((await D.post(`/api/invites/${cInv[0].id}/accept`)).status, 404);
  assert.equal((await C.post(`/api/invites/${cInv[0].id}/accept`)).status, 200);
  assert.equal((await C.get(`/api/projects/${Q.id}`)).body.role, 'member');
  // 멤버는 초대·내보내기 불가
  assert.equal((await C.post(`/api/projects/${Q.id}/invites`, { email: 'd@x.com' })).status, 403);
  assert.equal((await A.post(`/api/projects/${Q.id}/invites`, { email: 'c@x.com' })).status, 409);
  // D 도 초대 → 수락
  await A.post(`/api/projects/${Q.id}/invites`, { email: 'd@x.com' });
  await D.post(`/api/invites/${(await D.get('/api/invites')).body.invites[0].id}/accept`);

  // 파일 개별 공유: A 의 파일을 C 에게만
  const f = (await A.upload('report.docx', { projectId: Q.id })).body.file;
  assert.equal((await C.get(`/api/files/${f.id}`)).status, 404);
  assert.equal((await C.raw('PUT', `/api/files/${f.id}/shares`, { userIds: [cId] })).status, 404); // 남의 파일 공유 불가
  const outsider = db.prepare("SELECT id FROM users WHERE email='b@x.com'").get().id;
  assert.equal((await A.raw('PUT', `/api/files/${f.id}/shares`, { userIds: [outsider] })).status, 400); // 멤버가 아니면 공유 불가
  assert.equal((await A.raw('PUT', `/api/files/${f.id}/shares`, { userIds: [cId] })).status, 200);
  assert.equal((await C.get(`/api/files/${f.id}`)).status, 200);
  assert.equal((await C.get(`/api/files/${f.id}/download`)).status, 200);
  assert.equal((await D.get(`/api/files/${f.id}`)).status, 404);
  assert.deepEqual((await C.get(`/api/projects/${Q.id}`)).body.files.map((x) => x.id), [f.id]);
  assert.equal((await D.get(`/api/projects/${Q.id}`)).body.files.length, 0);
  assert.equal((await C.get(`/api/projects/${Q.id}`)).body.files[0].sharedWith, undefined); // 공유 대상 목록은 올린 사람만

  // 스레드 공유
  const t = (await A.post(`/api/projects/${Q.id}/threads`)).body;
  await A.post(`/api/conversations/${t.id}/files`, { fileId: f.id });
  assert.equal((await C.raw('PUT', `/api/conversations/${t.id}/members`, { userId: dId, permission: 'read' })).status, 404);
  assert.equal((await A.raw('PUT', `/api/conversations/${t.id}/members`, { userId: outsider, permission: 'read' })).status, 400);
  assert.equal((await A.raw('PUT', `/api/conversations/${t.id}/members`, { userId: cId, permission: 'admin' })).status, 400);
  const sh = await A.raw('PUT', `/api/conversations/${t.id}/members`, { userId: cId, permission: 'participate' });
  assert.equal(sh.status, 200);
  assert.equal(sh.body.files[0].usable, true); // C 가 볼 수 있으니 AI 가 사용
  seen.length = 0;
  assert.equal((await C.post(`/api/conversations/${t.id}/messages`, { content: 'C 의 질문' })).status, 200);
  assert.deepEqual(seen[0], ['report.docx']);
  // D 에게 읽기로 공유하면 D 는 파일을 못 보므로 AI 입력에서 빠진다
  const sh2 = await A.raw('PUT', `/api/conversations/${t.id}/members`, { userId: dId, permission: 'read' });
  assert.equal(sh2.body.files[0].usable, false);
  assert.equal((await D.get(`/api/conversations/${t.id}`)).body.files.length, 0); // D 에게 파일 정보도 안 보임
  assert.equal((await D.post(`/api/conversations/${t.id}/messages`, { content: '몰래' })).status, 403);
  seen.length = 0;
  await A.post(`/api/conversations/${t.id}/messages`, { content: '다시' });
  assert.deepEqual(seen[0], []);
  // 공유 해제 → 즉시 차단
  await A.del(`/api/conversations/${t.id}/members/${dId}`);
  assert.equal((await D.get(`/api/conversations/${t.id}`)).status, 404);

  // C 를 내보내면 공유받은 스레드·파일 모두 즉시 차단
  assert.equal((await C.del(`/api/projects/${Q.id}/members/${dId}`)).status, 403);
  assert.equal((await A.del(`/api/projects/${Q.id}/members/${cId}`)).status, 200);
  assert.equal((await C.get(`/api/conversations/${t.id}`)).status, 404);
  assert.equal((await C.get(`/api/files/${f.id}`)).status, 404);
  assert.equal((await C.get(`/api/projects/${Q.id}`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM file_shares WHERE user_id = ?').get(cId).n, 0);
  // 소유자는 나갈 수 없고, 멤버는 스스로 나갈 수 있다
  const aId = db.prepare("SELECT id FROM users WHERE email='a@x.com'").get().id;
  assert.equal((await A.del(`/api/projects/${Q.id}/members/${aId}`)).status, 400);
  assert.equal((await D.del(`/api/projects/${Q.id}/members/${dId}`)).status, 200);
  assert.equal((await D.get(`/api/projects/${Q.id}`)).status, 404);
});

test('3차: AI 가 공유 대화와 허용된 파일로 문서를 만들어 프로젝트에 저장', async () => {
  const E = client(); const G = client(); const H = client();
  await E.post('/api/auth/signup', { email: 'e@x.com', name: '이', password: 'password5' });
  await G.post('/api/auth/signup', { email: 'g@x.com', name: '지', password: 'password6' });
  await H.post('/api/auth/signup', { email: 'h@x.com', name: '해', password: 'password7' });
  const uid = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;
  const P3 = (await E.post('/api/projects', { name: '문서 프로젝트' })).body;
  for (const [C, mail] of [[G, 'g@x.com'], [H, 'h@x.com']]) {
    await E.post(`/api/projects/${P3.id}/invites`, { email: mail });
    await C.post(`/api/invites/${(await C.get('/api/invites')).body.invites[0].id}/accept`);
  }
  const pub = (await E.upload('sales.xlsx', { projectId: P3.id, visibility: 'project' })).body.file;
  const priv = (await E.upload('report.docx', { projectId: P3.id })).body.file;
  const t = (await E.post(`/api/projects/${P3.id}/threads`)).body;
  await E.post(`/api/conversations/${t.id}/files`, { fileId: pub.id });
  await E.post(`/api/conversations/${t.id}/files`, { fileId: priv.id });
  await E.raw('PUT', `/api/conversations/${t.id}/members`, { userId: uid('g@x.com'), permission: 'participate' });
  await G.post(`/api/conversations/${t.id}/messages`, { content: '매출이 늘었어요' });

  // 읽기 권한·비참여자는 문서를 만들 수 없다
  assert.equal((await H.post(`/api/conversations/${t.id}/documents`, { instruction: '회의록' })).status, 404);
  assert.equal((await G.post(`/api/conversations/${t.id}/documents`, {})).status, 400);

  const r = await G.post(`/api/conversations/${t.id}/documents`, { instruction: '회의록으로 정리', format: 'docx' });
  assert.equal(r.status, 200);
  // AI 에는 공유 대화 + 모든 참여자가 볼 수 있는 파일만 (E 의 비공개 report.docx 제외)
  assert.deepEqual(docCall.files, ['sales.xlsx']);
  assert.ok(docCall.history.some((m) => m.content === '매출이 늘었어요'));
  assert.equal(docCall.instruction, '회의록으로 정리');
  const doc = r.body.file;
  assert.equal(doc.name, '주간 회의록.docx');
  assert.equal(doc.aiGenerated, true);
  assert.equal(doc.projectId, P3.id);
  // 저장된 문서는 스레드 참여자(E, G)만 볼 수 있고 H 는 못 본다
  assert.equal((await E.get(`/api/files/${doc.id}`)).status, 200);
  assert.equal((await G.get(`/api/files/${doc.id}`)).status, 200);
  assert.equal((await H.get(`/api/files/${doc.id}`)).status, 404);
  assert.ok((await G.get(`/api/files/${doc.id}`)).body.preview.includes('| 매출 | 150 |'));
  // 진짜 Word 파일인지: 내려받아 다시 읽기
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'g@x.com', password: 'password6' }) });
  const res = await fetch(`${base}/api/files/${doc.id}/download`, { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } });
  const { extractFile } = require('../src/fileReader');
  const back = await extractFile(Buffer.from(await res.arrayBuffer()), 'x.docx');
  assert.equal(back.kind, 'text');
  assert.ok(back.text.includes('주간 회의록') && back.text.includes('매출'));
  // 스레드에 안내 메시지와 함께 붙어 있다
  assert.ok(r.body.conversation.files.some((f) => f.id === doc.id && f.usable));
  assert.match(r.body.conversation.messages.at(-1).content, /주간 회의록\.docx/);
  // 개인 대화에서 만들면 내 개인 파일
  const pc = (await H.post('/api/conversations')).body;
  const md = await H.post(`/api/conversations/${pc.id}/documents`, { instruction: '메모', format: 'md' });
  assert.equal(md.body.file.projectId, null);
  assert.equal(md.body.file.name, '주간 회의록.md');
  assert.equal((await E.get(`/api/files/${md.body.file.id}`)).status, 404);
});

test('잘못된 ID·로그아웃 처리', async () => {
  assert.equal((await A.get('/api/conversations/abc')).status, 404);
  assert.equal((await A.get('/api/files/999999')).status, 404);
  await A.post('/api/auth/logout');
  assert.equal((await A.get('/api/conversations')).status, 401);
});
