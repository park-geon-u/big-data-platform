const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { makeAuthz, HttpError, notFound } = require('./authz');
const { extractFile, SUPPORTED_LABEL, IMAGE_MIME } = require('./fileReader');
const ai = require('./ai');
const { makeUserAI } = require('./settings');
const { markdownToDocx } = require('./docBuilder');

const SESSION_DAYS = 14;
const MAX_UPLOAD = 50 * 1024 * 1024;

function createApp({
  dbFile, uploadDir, dataDir, generateReply = ai.generateReply, listModels = ai.listModels, generateDocument = ai.generateDocument,
  freeAI = {}, onChange,
} = {}) {
  const db = openDb(dbFile);
  const authz = makeAuthz(db);
  const userAI = makeUserAI(db, { dataDir, freeAI });
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  // 데이터를 바꾸는 요청이 성공하면 알린다 (무료 서버용 자동 백업에 사용)
  if (onChange) {
    app.use('/api', (req, res, next) => {
      if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) onChange(); });
      next();
    });
  }
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- 인증 ----------
  const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
    `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
  const checkPw = (pw, stored) => {
    const [salt, hash] = stored.split(':');
    const a = Buffer.from(hash, 'hex');
    const b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
      .run(token, userId, Date.now() + SESSION_DAYS * 864e5);
    res.cookie('sid', token, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_DAYS * 864e5, path: '/',
    });
  }
  const sessionUser = db.prepare(`SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`);

  // 모든 /api 요청에서 쿠키로 사용자 확인. 사용자 ID 는 클라이언트 입력이 아니라 세션에서만 온다.
  function requireUser(req, res, next) {
    const sid = req.cookies?.sid;
    const u = sid && sessionUser.get(sid, Date.now());
    if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
    req.user = { id: u.id, email: u.email, name: u.name };
    next();
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw notFound();
    return n;
  };
  const str = (v, field, max = 200, { required = true } = {}) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw new HttpError(400, `${field}을(를) 입력해 주세요.`);
    if (s.length > max) throw new HttpError(400, `${field}이(가) 너무 깁니다.`);
    return s;
  };

  app.post('/api/auth/signup', wrap(async (req, res) => {
    const email = str(req.body.email, '이메일', 200).toLowerCase();
    const name = str(req.body.name, '이름', 50);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, '이메일 형식이 올바르지 않습니다.');
    if (password.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, '이미 가입된 이메일입니다.');
    const r = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)').run(email, name, hashPw(password));
    startSession(res, r.lastInsertRowid);
    res.json({ user: { id: Number(r.lastInsertRowid), email, name } });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !checkPw(String(req.body.password || ''), u.password_hash)) {
      throw new HttpError(401, '이메일 또는 비밀번호가 맞지 않습니다.');
    }
    startSession(res, u.id);
    res.json({ user: { id: u.id, email: u.email, name: u.name } });
  }));

  app.post('/api/auth/logout', (req, res) => {
    if (req.cookies?.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireUser, (req, res) => {
    res.json({ user: req.user, ai: userAI.summary(req.user.id), supportedFiles: SUPPORTED_LABEL });
  });

  app.use('/api', requireUser);

  // ---------- 내 AI 설정 (사용자마다 자기 키) ----------
  // URL 에 사용자 ID 를 받지 않는다: 항상 로그인한 본인의 설정만 읽고 쓴다.
  const provider = (v) => {
    if (!Object.prototype.hasOwnProperty.call(ai.PROVIDERS, v)) throw new HttpError(400, '지원하지 않는 AI 입니다.');
    return v;
  };
  const modelName = (v) => {
    const m = String(v || '').trim();
    if (!/^[\w.\-:/]{1,100}$/.test(m)) throw new HttpError(400, '모델 이름이 올바르지 않습니다.');
    return m;
  };
  app.get('/api/me/ai', (req, res) => res.json(userAI.summary(req.user.id)));

  // 키 저장: 실제로 제공자 서버에 모델 목록을 요청해 보고, 성공해야 저장
  app.put('/api/me/ai/keys/:provider', wrap(async (req, res) => {
    const p = provider(req.params.provider);
    if (ai.PROVIDERS[p].keyOf) throw new HttpError(400, `${ai.PROVIDERS[p].label} 는 ${ai.PROVIDERS[ai.PROVIDERS[p].keyOf].label} 키를 함께 씁니다. 그쪽에 키를 넣어 주세요.`);
    const key = String(req.body.apiKey || '').trim();
    if (!key) throw new HttpError(400, 'API 키를 입력해 주세요.');
    if (key.length > 300 || /\s/.test(key)) throw new HttpError(400, 'API 키 형식이 올바르지 않습니다.');
    // 키 앞부분으로 다른 회사 키를 잘못 넣은 경우를 먼저 걸러낸다 (최종 확인은 아래에서 실제 서버로)
    const prefixes = [].concat(ai.PROVIDERS[p].keyPrefix);
    if (!prefixes.some((x) => key.startsWith(x))) {
      throw new HttpError(400, `${ai.PROVIDERS[p].label} 키는 보통 ${prefixes.map((x) => `"${x}"`).join(' 또는 ')} 로 시작합니다. 다른 회사의 키가 아닌지 확인해 주세요.`);
    }
    let models;
    try { models = await listModels(p, key); } catch (e) { throw new HttpError(400, e.message); }
    const def = ai.PROVIDERS[p].defaultModel;
    userAI.saveKey(req.user.id, p, key, models.includes(def) ? def : (models.find((m) => m.includes('latest')) || models[0]));
    // 처음 넣은 키라면 바로 그 AI 를 쓰도록
    if (!userAI.active(req.user.id).apiKey) userAI.setActive(req.user.id, p);
    res.json({ ...userAI.summary(req.user.id), models });
  }));

  app.delete('/api/me/ai/keys/:provider', (req, res) => {
    userAI.deleteKey(req.user.id, provider(req.params.provider));
    res.json(userAI.summary(req.user.id));
  });

  // 내 키로 쓸 수 있는 모델 목록
  app.get('/api/me/ai/models/:provider', wrap(async (req, res) => {
    const p = provider(req.params.provider);
    const key = userAI.apiKey(req.user.id, p);
    if (!key) return res.json({ models: ai.PROVIDERS[p].fallbackModels, fromKey: false });
    try { res.json({ models: await listModels(p, key), fromKey: true }); } catch (e) { throw new HttpError(400, e.message); }
  }));

  // 지금 쓸 AI·모델 고르기
  app.put('/api/me/ai/active', (req, res) => {
    const p = provider(req.body.provider);
    userAI.setActive(req.user.id, p, req.body.model ? modelName(req.body.model) : null);
    res.json(userAI.summary(req.user.id));
  });



  const freeLimitError = (limit) => new HttpError(429,
    `오늘 무료 AI 사용 횟수(${limit}회)를 모두 썼습니다. 내일 다시 쓰거나, ⚙ 내 AI 설정에서 내 API 키를 등록하면 제한 없이 쓸 수 있습니다.`);

  // ---------- 공통 직렬화 ----------
  const fileOut = (f) => ({
    id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind, note: f.extract_note,
    visibility: f.visibility, projectId: f.project_id, ownerId: f.owner_id, createdAt: f.created_at,
    chars: f.extracted_text ? f.extracted_text.length : 0,
    aiGenerated: f.source_conversation_id != null, sourceConversationId: f.source_conversation_id ?? null,
  });

  function convDetail(userId, convId) {
    const { conv, permission } = authz.conversation(userId, convId);
    const messages = db.prepare(`SELECT m.id, m.role, m.content, m.ai_model AS aiModel, m.created_at AS createdAt, m.author_id AS authorId, u.name AS authorName
      FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.conversation_id = ? ORDER BY m.id`).all(conv.id);
    const files = db.prepare(`SELECT f.* FROM conversation_files cf JOIN files f ON f.id = cf.file_id WHERE cf.conversation_id = ?`)
      .all(conv.id).filter((f) => authz.canReadFile(userId, f))
      // usable=false: 스레드 참여자 중 이 파일을 못 보는 사람이 있어 AI 가 쓰지 않는 파일
      .map((f) => ({ ...fileOut(f), usable: authz.fileUsableInConversation(conv, f) }));
    const members = conv.project_id == null ? [] : db.prepare(`SELECT u.id, u.name, u.email, tm.permission FROM thread_members tm
      JOIN users u ON u.id = tm.user_id WHERE tm.conversation_id = ? ORDER BY u.name`).all(conv.id);
    const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(conv.owner_id);
    return {
      id: conv.id, title: conv.title, projectId: conv.project_id, ownerId: conv.owner_id, ownerName: owner?.name,
      permission, messages, files, members, createdAt: conv.created_at,
    };
  }

  // ---------- 개인 AI 대화 ----------
  app.get('/api/conversations', (req, res) => {
    const rows = db.prepare(`SELECT id, title, updated_at AS updatedAt FROM conversations
      WHERE owner_id = ? AND project_id IS NULL ORDER BY updated_at DESC`).all(req.user.id);
    res.json({ conversations: rows });
  });

  app.post('/api/conversations', (req, res) => {
    const title = str(req.body.title, '제목', 100, { required: false }) || '새 대화';
    const r = db.prepare('INSERT INTO conversations (owner_id, title) VALUES (?,?)').run(req.user.id, title);
    res.json(convDetail(req.user.id, Number(r.lastInsertRowid)));
  });

  app.get('/api/conversations/:id', (req, res) => {
    res.json(convDetail(req.user.id, id(req.params.id)));
  });

  app.patch('/api/conversations/:id', (req, res) => {
    const { conv, permission } = authz.conversation(req.user.id, id(req.params.id));
    if (permission !== 'owner') throw new HttpError(403, '대화를 만든 사람만 이름을 바꿀 수 있습니다.');
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(str(req.body.title, '제목', 100), conv.id);
    res.json(convDetail(req.user.id, conv.id));
  });

  app.delete('/api/conversations/:id', (req, res) => {
    const { conv, permission } = authz.conversation(req.user.id, id(req.params.id));
    if (permission !== 'owner') throw new HttpError(403, '대화를 만든 사람만 삭제할 수 있습니다.');
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    res.json({ ok: true });
  });

  // 대화에 파일 붙이기 / 떼기
  app.post('/api/conversations/:id/files', (req, res) => {
    const { conv } = authz.conversationWrite(req.user.id, id(req.params.id));
    const f = authz.file(req.user.id, id(req.body.fileId));
    if (!authz.fileUsableInConversation(conv, f)) {
      throw new HttpError(403, conv.project_id
        ? '이 스레드의 모든 참여자가 볼 수 있는 같은 프로젝트 파일만 붙일 수 있습니다.'
        : '개인 대화에는 내 개인 파일만 붙일 수 있습니다.');
    }
    db.prepare('INSERT OR IGNORE INTO conversation_files (conversation_id, file_id) VALUES (?,?)').run(conv.id, f.id);
    res.json(convDetail(req.user.id, conv.id));
  });

  app.delete('/api/conversations/:id/files/:fileId', (req, res) => {
    const { conv } = authz.conversationWrite(req.user.id, id(req.params.id));
    db.prepare('DELETE FROM conversation_files WHERE conversation_id = ? AND file_id = ?').run(conv.id, id(req.params.fileId));
    res.json(convDetail(req.user.id, conv.id));
  });

  // 메시지 보내기 → AI 답변
  app.post('/api/conversations/:id/messages', wrap(async (req, res) => {
    const { conv } = authz.conversationWrite(req.user.id, id(req.params.id));
    const content = str(req.body.content, '메시지', 20000);
    // 질문한 사람의 키와 AI 로 답한다 (공유 스레드에서도 다른 사람의 키를 쓰지 않음).
    // 개인 키가 없으면 무료 기본 AI 를 하루 정해진 횟수만큼 쓴다 (횟수 검사도 서버에서).
    const me = userAI.resolve(req.user.id);
    if (me.limitReached) throw freeLimitError(me.limit);
    db.prepare('INSERT INTO messages (conversation_id, author_id, role, content) VALUES (?,?,?,?)')
      .run(conv.id, req.user.id, 'user', content);
    if (conv.title === '새 대화' || conv.title === '새 스레드') {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(content.replace(/\s+/g, ' ').slice(0, 40), conv.id);
    }
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);

    const history = db.prepare(`SELECT m.role, m.content, u.name AS author_name FROM messages m
      LEFT JOIN users u ON u.id = m.author_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 40`).all(conv.id).reverse();
    while (history.length && history[0].role !== 'user') history.shift();
    // AI 가 쓸 파일: 대화에 붙어 있고, 지금 이 순간에도 사용 가능한 것만 (권한 회수 반영)
    const files = db.prepare(`SELECT f.* FROM conversation_files cf JOIN files f ON f.id = cf.file_id WHERE cf.conversation_id = ?`)
      .all(conv.id).filter((f) => authz.canReadFile(req.user.id, f) && authz.fileUsableInConversation(conv, f));

    let reply;
    let aiLabel = null;
    try {
      aiLabel = me.apiKey ? `${me.model}${me.isFree ? ' (무료 기본)' : ''}` : null;
      reply = await generateReply(history, files, {
        multiUser: conv.project_id != null, provider: me.provider, model: me.model, apiKey: me.apiKey,
      });
    } catch (e) {
      console.error('AI error', e.message);
      me.refund(); // 실패한 질문은 무료 횟수에서 빼지 않는다
      reply = `⚠️ ${e.message}`;
      aiLabel = null;
    }
    db.prepare('INSERT INTO messages (conversation_id, author_id, role, content, ai_model) VALUES (?,?,?,?,?)')
      .run(conv.id, null, 'assistant', reply, aiLabel);
    res.json(convDetail(req.user.id, conv.id));
  }));

  // ---------- 3차: AI 문서 생성 ----------
  // 대화 내용과 (그 대화의 모든 참여자가 볼 수 있는) 첨부 파일만으로 AI 가 문서를 만들어 저장한다.
  // 프로젝트 스레드면 프로젝트 파일 저장소에 저장하고, 그 스레드 참여자 전원에게만 공유한다.
  app.post('/api/conversations/:id/documents', wrap(async (req, res) => {
    const { conv } = authz.conversationWrite(req.user.id, id(req.params.id));
    const instruction = str(req.body.instruction, '어떤 문서를 만들지', 2000);
    const format = req.body.format === 'docx' ? 'docx' : 'md';
    const history = db.prepare(`SELECT m.role, m.content, u.name AS author_name FROM messages m
      LEFT JOIN users u ON u.id = m.author_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 100`).all(conv.id).reverse();
    const files = db.prepare(`SELECT f.* FROM conversation_files cf JOIN files f ON f.id = cf.file_id WHERE cf.conversation_id = ?`)
      .all(conv.id).filter((f) => authz.canReadFile(req.user.id, f) && authz.fileUsableInConversation(conv, f));

    const me = userAI.resolve(req.user.id);
    if (me.limitReached) throw freeLimitError(me.limit);
    let md;
    try {
      md = await generateDocument(history, files, instruction, { provider: me.provider, model: me.model, apiKey: me.apiKey });
    } catch (e) {
      me.refund();
      throw new HttpError(502, `문서를 만들지 못했습니다: ${e.message}`);
    }
    const title = (str(req.body.title, '문서 이름', 100, { required: false })
      || md.match(/^#\s+(.+)$/m)?.[1] || instruction).replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80) || 'AI 문서';
    const name = `${title}.${format}`;
    const buf = format === 'docx' ? await markdownToDocx(md, title) : Buffer.from(md, 'utf8');
    const mime = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown';
    const storagePath = path.join(uploadDir, crypto.randomBytes(16).toString('hex'));
    fs.writeFileSync(storagePath, buf);

    const viewers = conv.project_id == null ? [] : [conv.owner_id,
      ...db.prepare('SELECT user_id FROM thread_members WHERE conversation_id = ?').all(conv.id).map((r) => r.user_id)]
      .filter((u) => u !== req.user.id && authz.isMember(conv.project_id, u));
    const fileId = db.transaction(() => {
      const r = db.prepare(`INSERT INTO files (owner_id, project_id, name, mime, size, storage_path, kind, extracted_text, extract_note, visibility, source_conversation_id)
        VALUES (?,?,?,?,?,?,'text',?,?,'private',?)`).run(req.user.id, conv.project_id, name, mime, buf.length, storagePath,
        md, 'AI 가 대화에서 만든 문서', conv.id);
      const fid = Number(r.lastInsertRowid);
      const share = db.prepare('INSERT OR IGNORE INTO file_shares (file_id, user_id) VALUES (?,?)');
      for (const u of viewers) share.run(fid, u);
      db.prepare('INSERT OR IGNORE INTO conversation_files (conversation_id, file_id) VALUES (?,?)').run(conv.id, fid);
      const where = conv.project_id == null ? '내 파일에' : `프로젝트 파일 저장소에${viewers.length ? ` (이 스레드 참여자 ${viewers.length}명과 공유)` : ''}`;
      db.prepare('INSERT INTO messages (conversation_id, author_id, role, content, ai_model) VALUES (?,?,?,?,?)')
        .run(conv.id, null, 'assistant', `📝 ${req.user.name}님의 요청으로 문서 **${name}** 을(를) 만들어 ${where} 저장했습니다.`,
          me.apiKey ? `${me.model}${me.isFree ? ' (무료 기본)' : ''}` : null);
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      return fid;
    })();
    res.json({ file: fileOut(db.prepare('SELECT * FROM files WHERE id = ?').get(fileId)), conversation: convDetail(req.user.id, conv.id) });
  }));

  // ---------- 프로젝트 ----------
  app.get('/api/projects', (req, res) => {
    const rows = db.prepare(`SELECT p.id, p.name, p.description, pm.role FROM projects p
      JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? ORDER BY p.created_at DESC`).all(req.user.id);
    res.json({ projects: rows });
  });

  app.post('/api/projects', (req, res) => {
    const name = str(req.body.name, '프로젝트 이름', 100);
    const description = str(req.body.description, '설명', 1000, { required: false });
    const pid = db.transaction(() => {
      const r = db.prepare('INSERT INTO projects (owner_id, name, description) VALUES (?,?,?)').run(req.user.id, name, description);
      db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,'owner')").run(r.lastInsertRowid, req.user.id);
      return Number(r.lastInsertRowid);
    })();
    res.json(projectDetail(req.user.id, pid));
  });

  function projectDetail(userId, pid) {
    const { project, role } = authz.project(userId, pid);
    // 내가 볼 수 있는 스레드만: 내가 만든 것 + 나에게 공유된 것
    const threads = db.prepare(`SELECT c.id, c.title, c.updated_at AS updatedAt, c.owner_id AS ownerId, u.name AS ownerName,
        CASE WHEN c.owner_id = ? THEN 'owner' ELSE tm.permission END AS permission
      FROM conversations c JOIN users u ON u.id = c.owner_id
      LEFT JOIN thread_members tm ON tm.conversation_id = c.id AND tm.user_id = ?
      WHERE c.project_id = ? AND (c.owner_id = ? OR tm.user_id IS NOT NULL)
      ORDER BY c.updated_at DESC`).all(userId, userId, pid, userId);
    const shareStmt = db.prepare('SELECT user_id FROM file_shares WHERE file_id = ?');
    const files = db.prepare(`SELECT f.*, u.name AS owner_name FROM files f JOIN users u ON u.id = f.owner_id
      WHERE f.project_id = ? ORDER BY f.created_at DESC`).all(pid)
      .filter((f) => authz.canReadFile(userId, f))
      .map((f) => ({
        ...fileOut(f), ownerName: f.owner_name,
        // 개별 공유 대상은 파일을 올린 사람에게만 보여 준다
        sharedWith: f.owner_id === userId ? shareStmt.all(f.id).map((r) => r.user_id) : undefined,
      }));
    const members = db.prepare(`SELECT u.id, u.name, u.email, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ? ORDER BY pm.role DESC, u.name`).all(pid);
    const invites = role !== 'owner' ? [] : db.prepare(`SELECT i.id, u.name, u.email, i.created_at AS createdAt FROM project_invites i
      JOIN users u ON u.id = i.invitee_id WHERE i.project_id = ? ORDER BY i.id`).all(pid);
    return { id: project.id, name: project.name, description: project.description, role, threads, files, members, invites };
  }

  app.get('/api/projects/:id', (req, res) => res.json(projectDetail(req.user.id, id(req.params.id))));

  app.patch('/api/projects/:id', (req, res) => {
    const pid = id(req.params.id);
    authz.projectOwner(req.user.id, pid);
    db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?')
      .run(str(req.body.name, '프로젝트 이름', 100), str(req.body.description, '설명', 1000, { required: false }), pid);
    res.json(projectDetail(req.user.id, pid));
  });

  app.delete('/api/projects/:id', (req, res) => {
    const pid = id(req.params.id);
    authz.projectOwner(req.user.id, pid);
    const paths = db.prepare('SELECT storage_path FROM files WHERE project_id = ?').all(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    for (const p of paths) fs.rm(p.storage_path, { force: true }, () => {});
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/threads', (req, res) => {
    const pid = id(req.params.id);
    authz.project(req.user.id, pid);
    const title = str(req.body.title, '제목', 100, { required: false }) || '새 스레드';
    const r = db.prepare('INSERT INTO conversations (owner_id, project_id, title) VALUES (?,?,?)').run(req.user.id, pid, title);
    res.json(convDetail(req.user.id, Number(r.lastInsertRowid)));
  });

  // ---------- 2차: 초대 · 멤버 ----------
  // 소유자가 가입된 사용자를 이메일로 초대 → 받은 사람이 수락해야 멤버가 된다
  app.post('/api/projects/:id/invites', (req, res) => {
    const pid = id(req.params.id);
    authz.projectOwner(req.user.id, pid);
    const email = str(req.body.email, '이메일', 200).toLowerCase();
    const u = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    if (!u) throw new HttpError(404, '가입된 사용자가 아닙니다. 먼저 회원가입을 해 달라고 알려 주세요.');
    if (authz.isMember(pid, u.id)) throw new HttpError(409, '이미 이 프로젝트의 참여자입니다.');
    db.prepare('INSERT OR IGNORE INTO project_invites (project_id, inviter_id, invitee_id) VALUES (?,?,?)').run(pid, req.user.id, u.id);
    res.json(projectDetail(req.user.id, pid));
  });

  app.delete('/api/projects/:id/invites/:inviteId', (req, res) => {
    const pid = id(req.params.id);
    authz.projectOwner(req.user.id, pid);
    db.prepare('DELETE FROM project_invites WHERE id = ? AND project_id = ?').run(id(req.params.inviteId), pid);
    res.json(projectDetail(req.user.id, pid));
  });

  // 나에게 온 초대
  app.get('/api/invites', (req, res) => {
    res.json({ invites: db.prepare(`SELECT i.id, p.id AS projectId, p.name AS projectName, u.name AS inviterName, i.created_at AS createdAt
      FROM project_invites i JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.inviter_id
      WHERE i.invitee_id = ? ORDER BY i.id DESC`).all(req.user.id) });
  });

  const myInvite = (userId, inviteId) => {
    const inv = db.prepare('SELECT * FROM project_invites WHERE id = ? AND invitee_id = ?').get(inviteId, userId);
    if (!inv) throw notFound(); // 남의 초대는 수락할 수 없다
    return inv;
  };
  app.post('/api/invites/:id/accept', (req, res) => {
    const inv = myInvite(req.user.id, id(req.params.id));
    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?,?,'member')").run(inv.project_id, req.user.id);
      db.prepare('DELETE FROM project_invites WHERE id = ?').run(inv.id);
    })();
    res.json({ projectId: inv.project_id });
  });
  app.post('/api/invites/:id/decline', (req, res) => {
    const inv = myInvite(req.user.id, id(req.params.id));
    db.prepare('DELETE FROM project_invites WHERE id = ?').run(inv.id);
    res.json({ ok: true });
  });

  // 멤버 내보내기(소유자) 또는 스스로 나가기. 나가는 즉시 그 프로젝트의 공유 권한도 모두 회수.
  app.delete('/api/projects/:id/members/:userId', (req, res) => {
    const pid = id(req.params.id);
    const target = id(req.params.userId);
    const { role } = authz.project(req.user.id, pid);
    if (target !== req.user.id && role !== 'owner') throw new HttpError(403, '프로젝트 소유자만 다른 사람을 내보낼 수 있습니다.');
    const m = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, target);
    if (!m) throw notFound();
    if (m.role === 'owner') throw new HttpError(400, '소유자는 나갈 수 없습니다. 프로젝트를 삭제해 주세요.');
    db.transaction(() => {
      db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(pid, target);
      db.prepare('DELETE FROM thread_members WHERE user_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)').run(target, pid);
      db.prepare('DELETE FROM file_shares WHERE user_id = ? AND file_id IN (SELECT id FROM files WHERE project_id = ?)').run(target, pid);
    })();
    res.json(target === req.user.id ? { ok: true } : projectDetail(req.user.id, pid));
  });

  // ---------- 2차: 스레드 공유 (읽기 / 참여) ----------
  app.put('/api/conversations/:id/members', (req, res) => {
    const { conv } = authz.conversationOwner(req.user.id, id(req.params.id));
    if (conv.project_id == null) throw new HttpError(400, '개인 AI 대화는 공유할 수 없습니다. 프로젝트 스레드를 사용해 주세요.');
    const target = id(req.body.userId);
    const permission = req.body.permission;
    if (!['read', 'participate'].includes(permission)) throw new HttpError(400, '권한은 read 또는 participate 입니다.');
    if (target === req.user.id) throw new HttpError(400, '자기 자신에게는 공유할 수 없습니다.');
    if (!authz.isMember(conv.project_id, target)) throw new HttpError(400, '같은 프로젝트 참여자에게만 공유할 수 있습니다.');
    db.prepare(`INSERT INTO thread_members (conversation_id, user_id, permission) VALUES (?,?,?)
      ON CONFLICT(conversation_id, user_id) DO UPDATE SET permission = excluded.permission`).run(conv.id, target, permission);
    res.json(convDetail(req.user.id, conv.id));
  });

  app.delete('/api/conversations/:id/members/:userId', (req, res) => {
    const { conv } = authz.conversationOwner(req.user.id, id(req.params.id));
    db.prepare('DELETE FROM thread_members WHERE conversation_id = ? AND user_id = ?').run(conv.id, id(req.params.userId));
    res.json(convDetail(req.user.id, conv.id));
  });

  // ---------- 2차: 파일을 특정 멤버에게 공유 ----------
  app.put('/api/files/:id/shares', (req, res) => {
    const f = authz.fileOwner(req.user.id, id(req.params.id));
    if (f.project_id == null) throw new HttpError(400, '개인 파일은 공유할 수 없습니다. 프로젝트에 올린 파일만 공유됩니다.');
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.map(id) : [];
    for (const u of userIds) {
      if (!authz.isMember(f.project_id, u)) throw new HttpError(400, '같은 프로젝트 참여자에게만 공유할 수 있습니다.');
    }
    db.transaction(() => {
      db.prepare('DELETE FROM file_shares WHERE file_id = ?').run(f.id);
      const ins = db.prepare('INSERT OR IGNORE INTO file_shares (file_id, user_id) VALUES (?,?)');
      for (const u of userIds) if (u !== f.owner_id) ins.run(f.id, u);
    })();
    res.json({ file: fileOut(f), sharedWith: db.prepare('SELECT user_id FROM file_shares WHERE file_id = ?').all(f.id).map((r) => r.user_id) });
  });

  // ---------- 파일 저장소 ----------
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
    }),
    limits: { fileSize: MAX_UPLOAD, files: 1 },
    defParamCharset: 'utf8',
  });

  app.post('/api/files', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? '파일은 50MB 까지 올릴 수 있습니다.' : err.message));
      next();
    });
  }, wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, '파일이 없습니다.');
    const cleanup = () => fs.rm(req.file.path, { force: true }, () => {});
    let projectId = null;
    let conv = null;
    try {
      if (req.body.projectId) {
        projectId = id(req.body.projectId);
        authz.project(req.user.id, projectId); // 멤버만 업로드 가능
      }
      if (req.body.conversationId) conv = authz.conversationWrite(req.user.id, id(req.body.conversationId)).conv;
    } catch (e) { cleanup(); throw e; }
    const name = path.basename(req.file.originalname).slice(0, 255) || 'file';
    const buf = fs.readFileSync(req.file.path);
    const ex = await extractFile(buf, name, req.file.mimetype);
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext] || req.file.mimetype || 'application/octet-stream';
    const visibility = projectId && req.body.visibility === 'project' ? 'project' : 'private';
    const r = db.prepare(`INSERT INTO files (owner_id, project_id, name, mime, size, storage_path, kind, extracted_text, extract_note, visibility)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, projectId, name, mime, req.file.size, req.file.path,
      ex.kind, ex.text ?? null, ex.note ?? null, visibility);
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(r.lastInsertRowid);

    // 대화 화면에서 올린 경우 바로 그 대화에 붙인다
    let attached = false;
    if (conv && authz.fileUsableInConversation(conv, f)) {
      db.prepare('INSERT OR IGNORE INTO conversation_files (conversation_id, file_id) VALUES (?,?)').run(conv.id, f.id);
      attached = true;
    }
    res.json({ file: fileOut(f), attached });
  }));

  // 개인 파일 목록 (프로젝트 파일은 프로젝트 상세에서)
  app.get('/api/files', (req, res) => {
    const rows = db.prepare('SELECT * FROM files WHERE owner_id = ? AND project_id IS NULL ORDER BY created_at DESC').all(req.user.id);
    res.json({ files: rows.map(fileOut) });
  });

  app.get('/api/files/:id', (req, res) => {
    const f = authz.file(req.user.id, id(req.params.id));
    res.json({ file: fileOut(f), preview: f.extracted_text ? f.extracted_text.slice(0, 5000) : null });
  });

  app.get('/api/files/:id/download', (req, res) => {
    const f = authz.file(req.user.id, id(req.params.id));
    const inline = req.query.inline === '1' && (f.kind === 'image' || f.mime === 'application/pdf');
    res.set('Content-Type', inline ? f.mime : 'application/octet-stream');
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    fs.createReadStream(f.storage_path).pipe(res);
  });

  app.patch('/api/files/:id', (req, res) => {
    const f = authz.fileOwner(req.user.id, id(req.params.id));
    const v = req.body.visibility;
    if (!['private', 'project'].includes(v)) throw new HttpError(400, '공개 범위 값이 올바르지 않습니다.');
    if (v === 'project' && f.project_id == null) throw new HttpError(400, '개인 파일은 프로젝트에 공개할 수 없습니다.');
    db.transaction(() => {
      db.prepare('UPDATE files SET visibility = ? WHERE id = ?').run(v, f.id);
      if (v === 'private') {
        // 비공개로 돌리면, 그 파일을 볼 수 없는 사람이 있는 스레드에서 떼어 낸다
        const convs = db.prepare('SELECT c.* FROM conversation_files cf JOIN conversations c ON c.id = cf.conversation_id WHERE cf.file_id = ?').all(f.id);
        const nf = { ...f, visibility: v };
        for (const c of convs) {
          if (!authz.fileUsableInConversation(c, nf)) {
            db.prepare('DELETE FROM conversation_files WHERE conversation_id = ? AND file_id = ?').run(c.id, f.id);
          }
        }
      }
    })();
    res.json({ file: fileOut(db.prepare('SELECT * FROM files WHERE id = ?').get(f.id)) });
  });

  app.delete('/api/files/:id', (req, res) => {
    const f = authz.fileOwner(req.user.id, id(req.params.id));
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    fs.rm(f.storage_path, { force: true }, () => {});
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: '없는 API 입니다.' }));

  // 에러 처리
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '잘못된 요청 형식입니다.' });
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  return { app, db };
}

module.exports = { createApp };
