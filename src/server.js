const path = require('path');
const fs = require('fs');
const { createApp } = require('./app');
const { makeBackup } = require('./backup');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// 개인 키가 없는 사용자를 위한 무료 기본 AI (키는 .env 나 호스팅의 환경 변수에만 둔다. 코드·깃허브에 넣지 말 것)
const freeAI = {
  apiKey: process.env.FREE_AI_KEY || null,
  provider: process.env.FREE_AI_PROVIDER || 'google',
  model: process.env.FREE_AI_MODEL || undefined,
  dailyLimit: process.env.FREE_AI_DAILY_LIMIT ? Number(process.env.FREE_AI_DAILY_LIMIT) : 5,
};

// 무료 서버용: 비공개 깃허브 저장소에 데이터 백업/복원 (설정했을 때만)
const backup = process.env.BACKUP_GITHUB_REPO && process.env.BACKUP_GITHUB_TOKEN
  ? makeBackup({ repo: process.env.BACKUP_GITHUB_REPO, token: process.env.BACKUP_GITHUB_TOKEN, dataDir })
  : null;

async function main() {
  if (backup) {
    if (!process.env.APP_SECRET) console.warn('⚠️ 백업을 쓸 때는 APP_SECRET 을 꼭 설정하세요. 없으면 서버가 다시 켜질 때 사용자 AI 키를 풀 수 없습니다.');
    // 디스크에 DB 가 없을 때만 (= 서버가 새로 켜졌을 때) 백업에서 복원
    if (!fs.existsSync(path.join(dataDir, 'app.db'))) await backup.restore();
  }
  const { app, db } = createApp({
    dbFile: path.join(dataDir, 'app.db'), uploadDir: path.join(dataDir, 'uploads'), dataDir, freeAI,
    onChange: backup ? () => backup.markDirty() : undefined,
  });
  if (backup) backup.attach(db);

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`AI 업무 비서: http://localhost:${port}`);
    if (freeAI.apiKey) console.log(`※ 무료 기본 AI 켜짐: 개인 키가 없는 사용자는 하루 ${freeAI.dailyLimit}회까지 사용`);
    if (backup) console.log(`※ 데이터 백업 켜짐: ${process.env.BACKUP_GITHUB_REPO}`);
    console.log('※ 각 사용자가 화면의 [⚙ 내 AI 설정]에서 자기 Claude·GPT·Gemini API 키를 넣습니다.');
  });

  // 서버가 꺼질 때(무료 서버가 잠들 때 포함) 남은 변경을 백업하고 종료
  const shutdown = async () => {
    server.close();
    if (backup) await backup.flush();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('서버 시작 실패:', e.message); process.exit(1); });
