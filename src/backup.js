// 무료 서버(Render 등)는 꺼졌다 켜지면 디스크가 초기화된다.
// 그래서 데이터(DB + 업로드 파일)를 비공개 깃허브 저장소에 압축해 백업하고, 서버가 켜질 때 복원한다.
//
// 환경 변수
//   BACKUP_GITHUB_REPO   백업용 "비공개" 저장소 (예: park-geon-u/ai-assistant-data)
//   BACKUP_GITHUB_TOKEN  그 저장소에만 Contents 읽기/쓰기 권한을 준 토큰
// 사용자 AI 키를 푸는 암호화 키(secret.key)는 백업에 넣지 않는다 → 배포 시 APP_SECRET 을 꼭 설정할 것.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKUP_PATH = 'backup/data.tar.gz';
const MAX_BYTES = 90 * 1024 * 1024; // 깃허브 API 한도(100MB) 안쪽

function makeBackup({ repo, token, dataDir, apiBase = 'https://api.github.com', fetchImpl = fetch, delayMs = 15000, log = console.log }) {
  const url = `${apiBase}/repos/${repo}/contents/${BACKUP_PATH}`;
  const headers = (accept = 'application/vnd.github+json') => ({
    authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'ai-work-assistant',
  });
  let sha = null;
  let db = null;
  let timer = null;
  let running = null;
  let again = false;

  /** 서버가 켜질 때: 백업이 있으면 data 폴더로 풀어 놓는다 */
  async function restore() {
    const meta = await fetchImpl(url, { headers: headers() });
    if (meta.status === 404) { log('[백업] 아직 백업이 없습니다. 새로 시작합니다.'); return false; }
    if (!meta.ok) throw new Error(`백업 확인 실패 (${meta.status}): ${(await meta.text()).slice(0, 200)}`);
    sha = (await meta.json()).sha;
    const raw = await fetchImpl(url, { headers: headers('application/vnd.github.raw+json') });
    if (!raw.ok) throw new Error(`백업 내려받기 실패 (${raw.status})`);
    const buf = Buffer.from(await raw.arrayBuffer());
    fs.mkdirSync(dataDir, { recursive: true });
    const tgz = path.join(os.tmpdir(), `restore-${Date.now()}.tar.gz`);
    fs.writeFileSync(tgz, buf);
    execFileSync('tar', ['-xzf', tgz, '-C', dataDir]);
    fs.rmSync(tgz, { force: true });
    log(`[백업] 복원 완료 (${(buf.length / 1024).toFixed(0)}KB)`);
    return true;
  }

  /** 지금 데이터를 압축해 깃허브에 올린다 */
  async function backupNow() {
    if (!db) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
    try {
      await db.backup(path.join(tmp, 'app.db')); // 쓰는 중이어도 일관된 DB 스냅숏
      const args = ['-czf', path.join(tmp, 'data.tar.gz'), '-C', tmp, 'app.db'];
      if (fs.existsSync(path.join(dataDir, 'uploads'))) args.push('-C', dataDir, 'uploads');
      execFileSync('tar', args);
      const buf = fs.readFileSync(path.join(tmp, 'data.tar.gz'));
      if (buf.length > MAX_BYTES) { log('[백업] 데이터가 90MB 를 넘어 백업하지 못했습니다. 큰 파일을 지워 주세요.'); return; }
      const put = (s) => fetchImpl(url, {
        method: 'PUT', headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ message: `데이터 백업 ${new Date().toISOString()}`, content: buf.toString('base64'), ...(s ? { sha: s } : {}) }),
      });
      let res = await put(sha);
      if (res.status === 409 || res.status === 422) {
        // sha 가 어긋났으면 최신 sha 를 받아 한 번 더
        const m = await fetchImpl(url, { headers: headers() });
        sha = m.ok ? (await m.json()).sha : null;
        res = await put(sha);
      }
      if (!res.ok) throw new Error(`백업 업로드 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
      sha = (await res.json()).content.sha;
      log(`[백업] 저장 완료 (${(buf.length / 1024).toFixed(0)}KB)`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function run() {
    if (running) { again = true; return running; }
    running = backupNow().catch((e) => log(`[백업] 오류: ${e.message}`)).finally(() => { running = null; });
    await running;
    if (again) { again = false; await run(); }
  }

  return {
    restore,
    attach(database) { db = database; },
    /** 데이터가 바뀌면 호출: 잠시 모았다가 한 번에 백업 */
    markDirty() {
      if (timer) return;
      timer = setTimeout(() => { timer = null; run(); }, delayMs);
    },
    /** 서버가 꺼지기 직전: 남은 변경을 바로 백업 */
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; await run(); } else if (running) await running;
    },
  };
}

module.exports = { makeBackup, BACKUP_PATH };
