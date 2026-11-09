// 무료 서버용 백업: 데이터 → (가짜) 깃허브 저장소 → 디스크가 초기화된 새 서버에서 복원
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { makeBackup, BACKUP_PATH } = require('../src/backup');

/** 깃허브 Contents API 흉내 (파일 하나만 저장) */
function fakeGitHub() {
  const store = { content: null, sha: null, puts: 0, auth: [] };
  const server = http.createServer((req, res) => {
    store.auth.push(req.headers.authorization);
    if (!req.url.endsWith(`/repos/me/data/contents/${BACKUP_PATH}`)) { res.writeHead(404); return res.end('{}'); }
    if (req.method === 'GET') {
      if (!store.content) { res.writeHead(404); return res.end('{"message":"Not Found"}'); }
      if (req.headers.accept.includes('raw')) { res.writeHead(200); return res.end(store.content); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sha: store.sha }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      if (store.sha && j.sha !== store.sha) { res.writeHead(409); return res.end('{"message":"sha mismatch"}'); }
      store.content = Buffer.from(j.content, 'base64');
      store.sha = `sha${++store.puts}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: { sha: store.sha } }));
    });
  });
  return { store, server };
}

async function boot(dataDir, apiBase) {
  const backup = makeBackup({ repo: 'me/data', token: 'tok', dataDir, apiBase, delayMs: 20, log: () => {} });
  if (!fs.existsSync(path.join(dataDir, 'app.db'))) await backup.restore();
  const { app, db } = createApp({
    dbFile: path.join(dataDir, 'app.db'), uploadDir: path.join(dataDir, 'uploads'), dataDir,
    generateReply: async () => '답', onChange: () => backup.markDirty(),
  });
  backup.attach(db);
  const server = app.listen(0);
  await new Promise((ok) => server.once('listening', ok));
  return { backup, db, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('백업 → 디스크 초기화 → 복원하면 계정·프로젝트·대화·파일이 그대로', async () => {
  process.env.APP_SECRET = 'test-secret-for-backup';
  const gh = fakeGitHub();
  gh.server.listen(0);
  await new Promise((ok) => gh.server.once('listening', ok));
  const apiBase = `http://127.0.0.1:${gh.server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));

  // 1) 첫 서버: 백업이 없어서 빈 상태로 시작
  const s1 = await boot(path.join(tmp, 'disk1'), apiBase);
  const res = await fetch(`${s1.base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.com', name: 'A', password: 'password1' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = (base, method, url, body) => fetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const p = await call(s1.base, 'POST', '/api/projects', { name: '남아야 하는 프로젝트' });
  const t = await call(s1.base, 'POST', `/api/projects/${p.id}/threads`, {});
  await call(s1.base, 'POST', `/api/conversations/${t.id}/messages`, { content: '기억해 줘' });
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'report.docx'))]), '보고서.docx');
  fd.append('projectId', String(p.id));
  const up = await fetch(`${s1.base}/api/files`, { method: 'POST', headers: { cookie }, body: fd }).then((r) => r.json());
  await new Promise((ok) => setTimeout(ok, 60));
  await s1.backup.flush(); // 서버가 잠들기 직전과 같은 상황
  s1.server.closeAllConnections(); s1.server.close();
  assert.ok(gh.store.content, '백업이 올라가야 함');
  assert.ok(gh.store.auth.every((a) => a === 'Bearer tok'));

  // 2) 디스크가 지워진 새 서버 (무료 서버가 잠들었다 깬 상황)
  const s2 = await boot(path.join(tmp, 'disk2'), apiBase);
  const me = await call(s2.base, 'GET', '/api/auth/me'); // 로그인 세션도 그대로
  assert.equal(me.user.email, 'a@x.com');
  const p2 = await call(s2.base, 'GET', `/api/projects/${p.id}`);
  assert.equal(p2.name, '남아야 하는 프로젝트');
  assert.equal(p2.files[0].name, '보고서.docx');
  const conv = await call(s2.base, 'GET', `/api/conversations/${t.id}`);
  assert.equal(conv.messages[0].content, '기억해 줘');
  const dl = await fetch(`${s2.base}/api/files/${up.file.id}/download`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(fs.readFileSync(path.join(__dirname, 'fixtures', 'report.docx'))));

  // 3) 새 서버에서 바뀐 내용도 다시 백업된다 (sha 이어서 갱신)
  await call(s2.base, 'POST', '/api/projects', { name: '두 번째' });
  await new Promise((ok) => setTimeout(ok, 60));
  const before = gh.store.puts;
  await call(s2.base, 'POST', '/api/projects', { name: '세 번째' });
  await new Promise((ok) => setTimeout(ok, 60));
  await s2.backup.flush();
  assert.ok(gh.store.puts > before);
  for (const srv of [s2.server, gh.server]) { srv.closeAllConnections(); srv.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.APP_SECRET;
});
