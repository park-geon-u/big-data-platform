const path = require('path');
const { createApp } = require('./app');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// 개인 키가 없는 사용자를 위한 무료 기본 AI (키는 .env 나 호스팅의 환경 변수에만 둔다. 코드·깃허브에 넣지 말 것)
const freeAI = {
  apiKey: process.env.FREE_AI_KEY || null,
  provider: process.env.FREE_AI_PROVIDER || 'google',
  model: process.env.FREE_AI_MODEL || undefined,
  dailyLimit: process.env.FREE_AI_DAILY_LIMIT ? Number(process.env.FREE_AI_DAILY_LIMIT) : 5,
};
const { app } = createApp({ dbFile: path.join(dataDir, 'app.db'), uploadDir: path.join(dataDir, 'uploads'), dataDir, freeAI });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`AI 업무 비서: http://localhost:${port}`);
  if (freeAI.apiKey) console.log(`※ 무료 기본 AI 켜짐: 개인 키가 없는 사용자는 하루 ${freeAI.dailyLimit}회까지 사용`);
  console.log('※ 각 사용자가 화면의 [⚙ 내 AI 설정]에서 자기 Claude·GPT·Gemini API 키를 넣습니다.');
});
