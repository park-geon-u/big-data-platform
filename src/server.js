const path = require('path');
const { createApp } = require('./app');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { app } = createApp({ dbFile: path.join(dataDir, 'app.db'), uploadDir: path.join(dataDir, 'uploads'), dataDir });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`AI 업무 비서: http://localhost:${port}`);
  console.log('※ 각 사용자가 화면의 [⚙ 내 AI 설정]에서 자기 Claude·GPT·Gemini API 키를 넣습니다.');
});
