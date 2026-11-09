// 사용자별 AI 설정: 제공자(Claude·GPT·Gemini)마다 자기 API 키와 모델, 지금 쓰는 제공자.
// 키는 AES-256-GCM 으로 암호화해 DB 에 저장하고, 화면에는 끝 4자리만 보여 준다.
// 키는 본인만 쓰고 바꿀 수 있다 (다른 사용자·프로젝트 멤버에게도 보이지 않음).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PROVIDERS } = require('./ai');

/** 암호화 키: APP_SECRET 환경 변수, 없으면 데이터 폴더의 secret.key (처음 실행 때 자동 생성) */
function loadSecret(dataDir) {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  if (!dataDir) return crypto.randomBytes(32); // 테스트용 (메모리)
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

function makeUserAI(db, { dataDir }) {
  const secret = loadSecret(dataDir);
  const encrypt = (plain) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', secret, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  };
  const decrypt = (blob) => {
    try {
      const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', secret, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch { return null; } // 암호화 키가 바뀌면 복호화 불가 → 다시 입력 필요
  };

  const q = {
    keys: db.prepare('SELECT provider, enc_key, key_hint, model FROM user_api_keys WHERE user_id = ?'),
    key: db.prepare('SELECT enc_key, model FROM user_api_keys WHERE user_id = ? AND provider = ?'),
    putKey: db.prepare(`INSERT INTO user_api_keys (user_id, provider, enc_key, key_hint, model) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, provider) DO UPDATE SET enc_key = excluded.enc_key, key_hint = excluded.key_hint,
      model = COALESCE(user_api_keys.model, excluded.model)`),
    delKey: db.prepare('DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?'),
    setModel: db.prepare('UPDATE user_api_keys SET model = ? WHERE user_id = ? AND provider = ?'),
    pref: db.prepare('SELECT provider FROM user_ai_prefs WHERE user_id = ?'),
    putPref: db.prepare(`INSERT INTO user_ai_prefs (user_id, provider) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider`),
    modelPref: db.prepare('SELECT model FROM user_model_prefs WHERE user_id = ? AND provider = ?'),
    putModelPref: db.prepare(`INSERT INTO user_model_prefs (user_id, provider, model) VALUES (?,?,?)
      ON CONFLICT(user_id, provider) DO UPDATE SET model = excluded.model`),
  };
  // Codex 처럼 다른 회사 키를 함께 쓰는 AI 는 그 키를 찾아 쓴다 (codex → openai)
  const keyOf = (provider) => PROVIDERS[provider].keyOf || provider;
  const modelFor = (userId, provider) => q.modelPref.get(userId, provider)?.model
    || (!PROVIDERS[provider].keyOf && q.key.get(userId, provider)?.model) || PROVIDERS[provider].defaultModel;

  return {
    /** 화면용 요약 (키 원문은 절대 포함하지 않음) */
    summary(userId) {
      const rows = Object.fromEntries(q.keys.all(userId).map((r) => [r.provider, r]));
      const active = this.active(userId);
      return {
        active: { provider: active.provider, model: active.model, hasKey: !!active.apiKey },
        providers: Object.entries(PROVIDERS).map(([id, p]) => ({
          id, label: p.label, keyUrl: p.keyUrl, keyPrefix: p.keyPrefix, keyOf: p.keyOf || null, note: p.note || null,
          hasKey: !!rows[keyOf(id)], keyHint: rows[keyOf(id)]?.key_hint || null,
          model: modelFor(userId, id), suggestedModels: p.fallbackModels,
        })),
      };
    },
    /** 지금 이 사용자가 질문할 때 쓸 제공자·모델·키 */
    active(userId) {
      let provider = q.pref.get(userId)?.provider;
      if (!PROVIDERS[provider]) {
        // 고른 적이 없으면 키가 있는 첫 제공자, 그것도 없으면 Claude
        provider = q.keys.all(userId)[0]?.provider || 'anthropic';
      }
      const row = q.key.get(userId, keyOf(provider));
      return {
        provider,
        model: modelFor(userId, provider),
        apiKey: row ? decrypt(row.enc_key) : null,
      };
    },
    apiKey(userId, provider) {
      const row = q.key.get(userId, keyOf(provider));
      return row ? decrypt(row.enc_key) : null;
    },
    saveKey(userId, provider, key, model) {
      q.putKey.run(userId, provider, encrypt(key), `…${key.slice(-4)}`, model || PROVIDERS[provider].defaultModel);
    },
    deleteKey(userId, provider) { q.delKey.run(userId, provider); },
    setActive(userId, provider, model) {
      q.putPref.run(userId, provider);
      if (model) q.putModelPref.run(userId, provider, model);
    },
  };
}

module.exports = { makeUserAI };
