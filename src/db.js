// SQLite 스키마. 2·3차(초대·공유·권한) 확장을 고려해 테이블을 미리 둔다.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- role: owner | member  (2차: 초대로 member 추가)
  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    PRIMARY KEY (project_id, user_id)
  );
  -- project_id 가 NULL 이면 개인 AI 대화, 값이 있으면 프로젝트 대화 스레드
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- 2·3차: 스레드 공유 (read = 열람만, participate = 메시지 작성·AI 질문)
  CREATE TABLE IF NOT EXISTS thread_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('read','participate')),
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    file_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- project_id NULL = 개인 파일. visibility: private(업로더만) | project(프로젝트 멤버 전체)
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    kind TEXT NOT NULL,             -- text | image | pdf | unsupported
    extracted_text TEXT,
    extract_note TEXT,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','project')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- 대화에 참고 자료로 붙인 파일
  CREATE TABLE IF NOT EXISTS conversation_files (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, file_id)
  );
  -- 사용자별 AI API 키 (암호화 저장). provider: anthropic | openai | google
  CREATE TABLE IF NOT EXISTS user_api_keys (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    enc_key TEXT NOT NULL,
    key_hint TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, provider)
  );
  -- 사용자가 지금 쓰는 AI 제공자
  CREATE TABLE IF NOT EXISTS user_ai_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_id, project_id);
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
  `);
  // 메시지마다 어떤 AI 가 답했는지 기록 (기존 DB 호환)
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'ai_model')) {
    db.exec('ALTER TABLE messages ADD COLUMN ai_model TEXT');
  }
  return db;
}

module.exports = { openDb };
