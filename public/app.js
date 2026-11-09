// AI 업무 비서 — 프론트엔드 (빌드 도구 없는 순수 JS)
// 화면은 권한에 맞게 버튼을 보이거나 숨기지만, 실제 권한 검사는 모두 서버가 한다.
const $ = (s, el = document) => el.querySelector(s);
const state = { me: null, info: null, convs: [], projects: [] };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);
const KIND = { text: '텍스트 추출됨', image: '이미지', pdf: 'PDF 원본', unsupported: '읽을 수 없음' };

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) { showAuth(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}

// 아주 작은 마크다운 렌더러 (항상 먼저 escape)
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${code}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>');
  const out = [];
  for (const para of s.split(/\n{2,}/)) {
    const lines = para.split('\n');
    if (lines.every((l) => /^\s*[-*] /.test(l))) out.push(`<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-*] /, '')}</li>`).join('')}</ul>`);
    else if (lines.every((l) => /^\s*\d+\. /.test(l))) out.push(`<ol>${lines.map((l) => `<li>${l.replace(/^\s*\d+\. /, '')}</li>`).join('')}</ol>`);
    else out.push(`<p>${lines.join('<br>')}</p>`);
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

// ---------- 인증 ----------
let authMode = 'login';
function showAuth() { $('#auth').classList.remove('hidden'); $('#main').classList.add('hidden'); }
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $('.signup-only').classList.toggle('hidden', authMode !== 'signup');
  $('#auth-form button').textContent = authMode === 'login' ? '로그인' : '가입하기';
  $('#auth-form [name=password]').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
}));
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  $('#auth-error').textContent = '';
  try {
    await api(`/api/auth/${authMode}`, { method: 'POST', body: fd });
    e.target.reset();
    await boot();
  } catch (err) { $('#auth-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.hash = ''; showAuth(); });

// ---------- 사이드바 ----------
async function loadSidebar() {
  const [c, p, i] = await Promise.all([api('/api/conversations'), api('/api/projects'), api('/api/invites')]);
  state.convs = c.conversations; state.projects = p.projects; state.invites = i.invites;
  renderSidebar();
}
function renderSidebar() {
  const h = location.hash;
  $('#invite-box').innerHTML = state.invites?.length ? `<h3>받은 초대</h3><ul class="list">${state.invites.map((v) => `
    <li style="padding:6px 10px;font-size:13px;background:#1f2937;border-radius:8px;margin-bottom:6px">
      <b>${esc(v.inviterName)}</b>님이 📁 <b>${esc(v.projectName)}</b> 에 초대했습니다.
      <div style="margin-top:6px;display:flex;gap:6px"><button class="primary small" data-acc="${v.id}">수락</button><button class="small" data-dec="${v.id}" style="background:none;color:#e5e7eb">거절</button></div>
    </li>`).join('')}</ul>` : '';
  $('#invite-box').querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api(`/api/invites/${b.dataset.acc}/accept`, { method: 'POST' });
    await loadSidebar(); location.hash = `#/project/${r.projectId}`; toast('프로젝트에 참여했습니다.');
  }));
  $('#invite-box').querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/invites/${b.dataset.dec}/decline`, { method: 'POST' }); await loadSidebar();
  }));
  $('#conv-list').innerHTML = state.convs.map((c) => `<li><a href="#/chat/${c.id}" class="${h === `#/chat/${c.id}` ? 'active' : ''}">${esc(c.title)}</a></li>`).join('')
    || '<li class="muted" style="padding:6px 10px;font-size:13px">아직 대화가 없습니다</li>';
  $('#project-list').innerHTML = state.projects.map((p) => `<li><a href="#/project/${p.id}" class="${h.startsWith(`#/project/${p.id}`) ? 'active' : ''}">📁 ${esc(p.name)}</a></li>`).join('')
    || '<li class="muted" style="padding:6px 10px;font-size:13px">프로젝트가 없습니다</li>';
}
$('#new-chat').addEventListener('click', async () => {
  const c = await api('/api/conversations', { method: 'POST', body: {} });
  await loadSidebar(); location.hash = `#/chat/${c.id}`;
});
$('#new-project').addEventListener('click', () => openModal(`
  <h2>새 프로젝트</h2>
  <form id="np"><label>이름<input name="name" required maxlength="100"></label>
  <label>설명<input name="description" maxlength="1000"></label>
  <div class="modal-actions"><button type="button" data-close>취소</button><button class="primary">만들기</button></div></form>`, (card) => {
  $('#np', card).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const p = await api('/api/projects', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      closeModal(); await loadSidebar(); location.hash = `#/project/${p.id}`;
    } catch (err) { toast(err.message); }
  });
}));

function openModal(html, setup) {
  $('#modal-card').innerHTML = html; $('#modal').classList.remove('hidden');
  $('#modal-card').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  setup?.($('#modal-card'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ---------- 라우터 ----------
window.addEventListener('hashchange', route);
async function route() {
  if (!state.me) return;
  $('#sidebar').classList.remove('open');
  renderSidebar();
  const h = location.hash;
  let m;
  try {
    if ((m = h.match(/^#\/chat\/(\d+)$/))) return await renderChat(+m[1]);
    if ((m = h.match(/^#\/project\/(\d+)\/thread\/(\d+)$/))) return await renderChat(+m[2]);
    if ((m = h.match(/^#\/project\/(\d+)$/))) return await renderProject(+m[1]);
    if (h === '#/settings') return await renderSettings();
    renderHome();
  } catch (err) {
    $('#view').innerHTML = `<div class="page"><p class="error">${esc(err.message)}</p></div>`;
  }
}
const menuBtn = '<button class="menu-btn small" onclick="document.getElementById(\'sidebar\').classList.toggle(\'open\')">☰</button>';

function renderHome() {
  $('#view').innerHTML = `${'<div class="chat-head">' + menuBtn + '<h2>홈</h2></div>'}
  <div class="messages"><div class="empty">
    <h2>안녕하세요, ${esc(state.me.name)}님</h2>
    <p>왼쪽에서 <b>새 대화</b>를 시작하거나 <b>프로젝트</b>를 만들어 파일을 올려 보세요.</p>
    <p class="muted" style="font-size:13px">AI 가 읽을 수 있는 파일: ${esc(state.info.supportedFiles)}</p>
    ${state.info.ai.active.hasKey ? `<p class="muted">지금 쓰는 AI: <b>${esc(state.info.ai.active.model)}</b></p>`
    : '<p class="chip warn" style="display:inline-block;padding:8px 12px">아직 내 AI 키가 없어 데모 응답으로 동작합니다. <a href="#/settings">⚙ 내 AI 설정에서 Claude·GPT·Gemini 키 넣기</a></p>'}
  </div></div>`;
}

// ---------- 대화 화면 (개인 대화 + 프로젝트 스레드 공용) ----------
async function renderChat(convId) {
  const c = await api(`/api/conversations/${convId}`);
  const canWrite = c.permission !== 'read';
  const isThread = c.projectId != null;
  const project = isThread ? state.projects.find((p) => p.id === c.projectId) : null;
  $('#view').innerHTML = `
    <div class="chat-head">${menuBtn}
      ${isThread ? `<a class="crumb" href="#/project/${c.projectId}">📁 ${esc(project?.name || '프로젝트')} /</a>` : ''}
      <h2 id="conv-title" title="${esc(c.title)}">${esc(c.title)}</h2>
      ${canWrite ? aiPickerHtml() : ''}
      ${c.permission !== 'owner' ? `<span class="badge">${esc(c.ownerName)}님의 스레드 · ${c.permission === 'read' ? '읽기 전용' : '참여'}</span>` : ''}
      ${isThread && c.permission === 'owner' ? `<button class="small" id="share">👥 공유${c.members.length ? ` (${c.members.length})` : ''}</button>` : ''}
      ${c.permission === 'owner' ? '<button class="small" id="rename">이름 변경</button><button class="small danger" id="del">삭제</button>' : ''}
    </div>
    <div class="messages" id="msgs"></div>
    <div class="attachments" id="atts"></div>
    ${canWrite ? `<form class="composer" id="composer">
      <input type="file" id="file-in" hidden>
      <button type="button" class="attach" id="attach" title="파일 올리기">📎</button>
      ${isThread ? '<button type="button" class="attach small" id="pick" title="프로젝트 파일 붙이기">📁</button>' : ''}
      <textarea id="input" rows="1" placeholder="메시지를 입력하세요 (Shift+Enter 줄바꿈)"></textarea>
      <button class="primary" id="send">보내기</button>
    </form>` : '<p class="muted" style="padding:12px 20px">읽기 권한만 있어 메시지를 쓸 수 없습니다.</p>'}`;

  const paint = (conv) => {
    $('#conv-title').textContent = conv.title; c.title = conv.title;
    const box = $('#msgs');
    box.innerHTML = conv.messages.length ? conv.messages.map((m) => `
      <div class="msg ${m.role}">
        ${m.role === 'assistant' ? `<div class="who">AI${m.aiModel ? ` · ${esc(m.aiModel)}` : ''}</div>` : isThread ? `<div class="who">${esc(m.authorName || '알 수 없음')}</div>` : ''}
        ${m.role === 'assistant' ? md(m.content) : `<div class="body">${esc(m.content)}</div>`}
      </div>`).join('')
      : `<div class="empty"><h2>무엇을 도와드릴까요?</h2><p>📎 로 파일을 올리면 AI 가 내용을 읽고 답합니다.<br><span class="muted" style="font-size:13px">${esc(state.info.supportedFiles)}</span></p></div>`;
    box.scrollTop = box.scrollHeight;
    $('#atts').innerHTML = conv.files.map((f) => `<span class="chip ${f.kind === 'unsupported' || !f.usable ? 'warn' : ''}"
      title="${esc(!f.usable ? '스레드 참여자 중 이 파일을 볼 수 없는 사람이 있어 AI 가 사용하지 않습니다.' : (f.note || KIND[f.kind]))}">
      <span>${f.usable ? '📄' : '🚫'} ${esc(f.name)}</span>${canWrite ? `<button data-detach="${f.id}" title="대화에서 빼기">✕</button>` : ''}</span>`).join('');
    $('#atts').querySelectorAll('[data-detach]').forEach((b) => b.addEventListener('click', async () => {
      paint(await api(`/api/conversations/${convId}/files/${b.dataset.detach}`, { method: 'DELETE' }));
    }));
  };
  paint(c);

  $('#share')?.addEventListener('click', () => openThreadShare(c, () => renderChat(convId)));
  $('#rename')?.addEventListener('click', async () => {
    const t = prompt('새 이름', c.title); if (!t) return;
    await api(`/api/conversations/${convId}`, { method: 'PATCH', body: { title: t } });
    await loadSidebar(); route();
  });
  $('#del')?.addEventListener('click', async () => {
    if (!confirm('이 대화를 삭제할까요?')) return;
    await api(`/api/conversations/${convId}`, { method: 'DELETE' });
    await loadSidebar(); location.hash = isThread ? `#/project/${c.projectId}` : '';
  });
  if (!canWrite) return;
  bindAiPicker();

  const input = $('#input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    input.value = ''; input.style.height = 'auto';
    $('#send').disabled = true;
    const box = $('#msgs');
    if (box.querySelector('.empty')) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="body">${esc(text)}</div></div><div class="typing" id="typing">AI 가 답변을 작성하는 중…</div>`);
    box.scrollTop = box.scrollHeight;
    try {
      paint(await api(`/api/conversations/${convId}/messages`, { method: 'POST', body: { content: text } }));
      loadSidebar();
    } catch (err) { toast(err.message); $('#typing')?.remove(); input.value = text; }
    $('#send').disabled = false; input.focus();
  });

  $('#attach').addEventListener('click', () => $('#file-in').click());
  $('#file-in').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    toast(`"${file.name}" 올리는 중…`);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('conversationId', convId);
    if (isThread) fd.append('projectId', c.projectId);
    try {
      const r = await api('/api/files', { method: 'POST', body: fd });
      toast(r.file.kind === 'unsupported' ? r.file.note : `"${r.file.name}" 을(를) 대화에 붙였습니다.`);
      paint(await api(`/api/conversations/${convId}`));
    } catch (err) { toast(err.message); }
  });

  $('#pick')?.addEventListener('click', async () => {
    const p = await api(`/api/projects/${c.projectId}`);
    const attached = new Set((await api(`/api/conversations/${convId}`)).files.map((f) => f.id));
    const list = p.files.filter((f) => !attached.has(f.id));
    openModal(`<h2>프로젝트 파일 붙이기</h2>
      ${list.length ? `<ul class="rows">${list.map((f) => `<li><span class="grow">📄 ${esc(f.name)} <span class="muted">· ${KIND[f.kind]} · ${f.visibility === 'project' ? '프로젝트 공개' : '나만 보기'}</span></span>
        <button class="small" data-pick="${f.id}">붙이기</button></li>`).join('')}</ul>` : '<p class="muted">붙일 수 있는 파일이 없습니다.</p>'}
      <div class="modal-actions"><button data-close>닫기</button></div>`, (card) => {
      card.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async () => {
        try { paint(await api(`/api/conversations/${convId}/files`, { method: 'POST', body: { fileId: +b.dataset.pick } })); b.closest('li').remove(); } catch (err) { toast(err.message); }
      }));
    });
  });
}

// ---------- 프로젝트 화면 ----------
async function renderProject(pid) {
  const p = await api(`/api/projects/${pid}`);
  const isOwner = p.role === 'owner';
  $('#view').innerHTML = `<div class="page">
    <div style="display:flex;gap:10px;align-items:flex-start">${menuBtn}<div style="flex:1;min-width:0">
      <h1>📁 ${esc(p.name)}</h1><p class="muted" style="margin:0">${esc(p.description) || '설명 없음'}</p></div>
      ${isOwner ? '<button class="small" id="edit-p">수정</button><button class="small danger" id="del-p">삭제</button>' : ''}</div>
    <div class="grid2">
      <div class="card"><h2>대화 스레드 <button class="primary small" id="new-thread">+ 새 스레드</button></h2>
        <ul class="rows">${p.threads.map((t) => `<li><a class="grow" href="#/project/${pid}/thread/${t.id}">💬 ${esc(t.title)}</a>
          <span class="muted" style="font-size:12px">${t.permission === 'owner' ? '내 스레드' : `${esc(t.ownerName)} · ${t.permission === 'read' ? '읽기' : '참여'}`}</span></li>`).join('')
          || '<li class="muted">스레드가 없습니다. 스레드는 만든 사람과 공유받은 사람에게만 보입니다.</li>'}</ul>
      </div>
      <div class="card"><h2>파일 저장소</h2>
        <div class="drop" id="drop">여기에 파일을 끌어다 놓거나 <button class="link" id="up">파일 선택</button><br>
          <span style="font-size:12px">${esc(state.info.supportedFiles)}</span></div>
        <input type="file" id="pf" hidden multiple>
        <ul class="rows">${p.files.map((f) => `<li>
          <span class="grow" title="${esc(f.note || '')}"><a href="#" data-view="${f.id}">📄 ${esc(f.name)}</a>
            <span class="muted" style="font-size:12px"> · ${fmtSize(f.size)} · ${KIND[f.kind]}${f.ownerId !== state.me.id ? ` · ${esc(f.ownerName)}` : ''}</span></span>
          ${f.ownerId === state.me.id ? `<select data-vis="${f.id}" style="width:auto;padding:4px 6px;font-size:12px">
              <option value="private" ${f.visibility === 'private' && !f.sharedWith.length ? 'selected' : ''}>나만 보기</option>
              <option value="some" ${f.visibility === 'private' && f.sharedWith.length ? 'selected' : ''}>일부 공유 (${f.sharedWith.length}명)</option>
              <option value="project" ${f.visibility === 'project' ? 'selected' : ''}>프로젝트 공개</option></select>
            <button class="small danger" data-delf="${f.id}">삭제</button>` : `<span class="badge">${f.visibility === 'project' ? '프로젝트 공개' : '나에게 공유됨'}</span>`}
        </li>`).join('') || '<li class="muted">파일이 없습니다.</li>'}</ul>
      </div>
      <div class="card"><h2>참여자</h2>
        <ul class="rows">${p.members.map((m) => `<li><span class="grow">${esc(m.name)} <span class="muted">${esc(m.email)}</span></span>
          <span class="badge">${m.role === 'owner' ? '소유자' : '멤버'}</span>
          ${isOwner && m.role !== 'owner' ? `<button class="small danger" data-kick="${m.id}" data-name="${esc(m.name)}">내보내기</button>` : ''}</li>`).join('')}
          ${p.invites.map((v) => `<li><span class="grow muted">${esc(v.name)} ${esc(v.email)}</span><span class="badge" style="background:#fef3c7;color:#92400e">초대 대기</span>
            <button class="small" data-uninv="${v.id}">취소</button></li>`).join('')}</ul>
        ${isOwner ? `<form id="inv" style="display:flex;gap:8px;margin-top:10px"><input name="email" type="email" required placeholder="초대할 사람의 가입 이메일"><button class="primary small">초대</button></form>
          <p class="muted" style="font-size:12px">초대받은 사람이 수락하면 참여자가 됩니다. 참여자가 되어도 다른 사람의 비공개 스레드·파일은 자동으로 보이지 않습니다.</p>`
    : '<button class="small danger" id="leave" style="margin-top:10px">프로젝트 나가기</button>'}
      </div>
    </div></div>`;

  $('#new-thread').addEventListener('click', async () => {
    const t = await api(`/api/projects/${pid}/threads`, { method: 'POST', body: {} });
    location.hash = `#/project/${pid}/thread/${t.id}`;
  });
  $('#edit-p')?.addEventListener('click', () => openModal(`<h2>프로젝트 수정</h2><form id="ep">
    <label>이름<input name="name" required maxlength="100" value="${esc(p.name)}"></label>
    <label>설명<input name="description" maxlength="1000" value="${esc(p.description)}"></label>
    <div class="modal-actions"><button type="button" data-close>취소</button><button class="primary">저장</button></div></form>`, (card) => {
    $('#ep', card).addEventListener('submit', async (e) => {
      e.preventDefault();
      await api(`/api/projects/${pid}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) });
      closeModal(); await loadSidebar(); route();
    });
  }));
  $('#del-p')?.addEventListener('click', async () => {
    if (!confirm('프로젝트와 안의 모든 스레드·파일을 삭제할까요?')) return;
    await api(`/api/projects/${pid}`, { method: 'DELETE' }); await loadSidebar(); location.hash = '';
  });

  $('#inv')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/api/projects/${pid}/invites`, { method: 'POST', body: { email: e.target.email.value } }); toast('초대를 보냈습니다.'); renderProject(pid); } catch (err) { toast(err.message); }
  });
  document.querySelectorAll('[data-uninv]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/projects/${pid}/invites/${b.dataset.uninv}`, { method: 'DELETE' }); renderProject(pid);
  }));
  document.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`${b.dataset.name}님을 내보낼까요? 공유받은 스레드·파일 접근도 바로 막힙니다.`)) return;
    await api(`/api/projects/${pid}/members/${b.dataset.kick}`, { method: 'DELETE' }); toast('내보냈습니다.'); renderProject(pid);
  }));
  $('#leave')?.addEventListener('click', async () => {
    if (!confirm('이 프로젝트에서 나갈까요?')) return;
    await api(`/api/projects/${pid}/members/${state.me.id}`, { method: 'DELETE' }); await loadSidebar(); location.hash = '';
  });

  const uploadFiles = async (files) => {
    for (const file of files) {
      toast(`"${file.name}" 올리는 중…`);
      const fd = new FormData(); fd.append('file', file); fd.append('projectId', pid);
      try {
        const r = await api('/api/files', { method: 'POST', body: fd });
        if (r.file.kind === 'unsupported') toast(r.file.note);
      } catch (err) { toast(err.message); }
    }
    renderProject(pid);
  };
  $('#up').addEventListener('click', () => $('#pf').click());
  $('#pf').addEventListener('change', (e) => uploadFiles([...e.target.files]));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });

  document.querySelectorAll('[data-vis]').forEach((s) => s.addEventListener('change', async () => {
    const f = p.files.find((x) => x.id === +s.dataset.vis);
    try {
      if (s.value === 'some') return openFileShare(f, p.members, () => renderProject(pid));
      await api(`/api/files/${f.id}`, { method: 'PATCH', body: { visibility: s.value } });
      if (s.value === 'private' && f.sharedWith.length) await api(`/api/files/${f.id}/shares`, { method: 'PUT', body: { userIds: [] } });
      toast('공개 범위를 바꿨습니다.'); renderProject(pid);
    } catch (err) { toast(err.message); renderProject(pid); }
  }));
  document.querySelectorAll('[data-delf]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('파일을 삭제할까요?')) return;
    await api(`/api/files/${b.dataset.delf}`, { method: 'DELETE' }); renderProject(pid);
  }));
  document.querySelectorAll('[data-view]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); previewFile(+a.dataset.view); }));
}

// 파일을 특정 멤버에게만 공유
function openFileShare(f, members, done) {
  const others = members.filter((m) => m.id !== state.me.id);
  openModal(`<h2>"${esc(f.name)}" 공유할 사람</h2>
    ${others.length ? `<ul class="rows">${others.map((m) => `<li><label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit;font-size:14px">
      <input type="checkbox" value="${m.id}" style="width:auto" ${f.sharedWith.includes(m.id) ? 'checked' : ''}> ${esc(m.name)} <span class="muted">${esc(m.email)}</span></label></li>`).join('')}</ul>`
    : '<p class="muted">공유할 다른 참여자가 없습니다. 먼저 프로젝트에 초대해 주세요.</p>'}
    <div class="modal-actions"><button data-close>취소</button><button class="primary" id="fs-save">저장</button></div>`, (card) => {
    $('#fs-save', card).addEventListener('click', async () => {
      const userIds = [...card.querySelectorAll('input:checked')].map((i) => +i.value);
      try {
        if (f.visibility === 'project') await api(`/api/files/${f.id}`, { method: 'PATCH', body: { visibility: 'private' } });
        await api(`/api/files/${f.id}/shares`, { method: 'PUT', body: { userIds } });
        closeModal(); toast(userIds.length ? `${userIds.length}명에게 공유했습니다.` : '나만 보기로 바꿨습니다.'); done();
      } catch (err) { toast(err.message); }
    });
    card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', done));
  });
}

// 스레드 공유: 프로젝트 참여자마다 공유 안 함 / 읽기 / 참여
async function openThreadShare(c, done) {
  const p = await api(`/api/projects/${c.projectId}`);
  const others = p.members.filter((m) => m.id !== state.me.id);
  const cur = Object.fromEntries(c.members.map((m) => [m.id, m.permission]));
  openModal(`<h2>스레드 공유</h2>
    <p class="muted" style="font-size:13px">읽기: 대화를 볼 수만 있음 · 참여: 메시지 작성과 AI 질문 가능. 공유하면 이 스레드의 AI 는 모든 참여자가 볼 수 있는 파일만 사용합니다.</p>
    ${others.length ? `<ul class="rows">${others.map((m) => `<li><span class="grow">${esc(m.name)} <span class="muted">${esc(m.email)}</span></span>
      <select data-tm="${m.id}" style="width:auto;padding:4px 6px;font-size:13px">
        <option value="">공유 안 함</option>
        <option value="read" ${cur[m.id] === 'read' ? 'selected' : ''}>읽기</option>
        <option value="participate" ${cur[m.id] === 'participate' ? 'selected' : ''}>참여</option></select></li>`).join('')}</ul>`
    : '<p class="muted">공유할 다른 참여자가 없습니다. 먼저 프로젝트에 초대해 주세요.</p>'}
    <div class="modal-actions"><button data-close>닫기</button></div>`, (card) => {
    card.querySelectorAll('[data-tm]').forEach((sel) => sel.addEventListener('change', async () => {
      const uid = sel.dataset.tm;
      try {
        if (sel.value) await api(`/api/conversations/${c.id}/members`, { method: 'PUT', body: { userId: +uid, permission: sel.value } });
        else await api(`/api/conversations/${c.id}/members/${uid}`, { method: 'DELETE' });
        toast(sel.value ? '공유 권한을 바꿨습니다.' : '공유를 해제했습니다. 이제 이 사람은 스레드를 볼 수 없습니다.');
      } catch (err) { toast(err.message); }
    }));
    card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', done));
  });
}

async function previewFile(fid) {
  const { file: f, preview } = await api(`/api/files/${fid}`);
  const url = `/api/files/${fid}/download`;
  openModal(`<h2 style="font-size:16px;word-break:break-all">${esc(f.name)}</h2>
    <p class="muted" style="font-size:13px">${fmtSize(f.size)} · ${KIND[f.kind]}${f.note ? ` · ${esc(f.note)}` : ''}</p>
    ${f.kind === 'image' ? `<img src="${url}?inline=1" alt="${esc(f.name)}">` : ''}
    ${preview ? `<p class="muted" style="font-size:12px">AI 가 읽는 내용 (${f.chars.toLocaleString()}자 중 앞부분)</p><pre>${esc(preview)}</pre>` : ''}
    <div class="modal-actions"><a href="${url}"><button>내려받기</button></a><button data-close class="primary">닫기</button></div>`);
}

// ---------- 대화 화면의 AI 선택 ----------
function aiPickerHtml() {
  const ai = state.info.ai;
  const opts = ai.providers.map((p) => `<option value="${p.id}" ${p.id === ai.active.provider ? 'selected' : ''}>
    ${esc(p.label.split(' ')[0])} · ${esc(p.id === ai.active.provider ? ai.active.model : p.model)}${p.hasKey ? '' : ' (키 없음)'}</option>`).join('');
  return `<select id="ai-pick" title="이 질문에 쓸 AI" style="width:auto;max-width:240px;padding:5px 8px;font-size:13px">${opts}</select>`;
}
function bindAiPicker() {
  $('#ai-pick')?.addEventListener('change', async (e) => {
    const p = state.info.ai.providers.find((x) => x.id === e.target.value);
    try {
      state.info.ai = await api('/api/me/ai/active', { method: 'PUT', body: { provider: p.id } });
      toast(p.hasKey ? `이제 ${p.label} 로 답합니다.` : `${p.label} 키가 없어 데모 응답이 나옵니다. ⚙ 내 AI 설정에서 키를 넣어 주세요.`);
    } catch (err) { toast(err.message); }
  });
}

// ---------- 내 AI 설정 (사용자마다 자기 키) ----------
async function renderSettings() {
  const ai = await api('/api/me/ai');
  state.info.ai = ai;
  $('#view').innerHTML = `<div class="page" style="max-width:720px">
    <div style="display:flex;gap:10px;align-items:center">${menuBtn}<h1>⚙ 내 AI 설정</h1></div>
    <p class="muted">내 API 키를 넣으면 그 AI 로 답을 받습니다. 키는 암호화해서 보관하고, 나만 쓸 수 있으며 다른 사용자에게는 보이지 않습니다.
      공유 스레드에서도 질문한 사람 본인의 키로 답합니다.</p>
    ${ai.providers.map((p) => `
    <div class="card" style="margin-top:16px" data-prov="${p.id}">
      <h2>${esc(p.label)}
        ${ai.active.provider === p.id ? '<span class="badge">지금 사용 중</span>' : `<button class="small" data-use>이 AI 쓰기</button>`}</h2>
      <p style="margin-top:0">${p.hasKey
    ? `<span class="badge" style="background:#dcfce7;color:#166534">연결됨</span> 키 ${esc(p.keyHint)}`
    : `<span class="badge" style="background:#fef3c7;color:#92400e">키 없음</span>`}</p>
      ${p.note ? `<p class="muted" style="font-size:13px;margin-top:-4px">${esc(p.note)}</p>` : ''}
      ${p.keyOf ? '' : `<form data-keyform style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
        <input name="apiKey" type="password" placeholder="${esc(p.keyPrefix)}..." autocomplete="off" spellcheck="false" style="flex:1;min-width:200px">
        <button class="primary" data-save>${p.hasKey ? '키 바꾸기' : '확인 후 저장'}</button>
        ${p.hasKey ? '<button type="button" class="danger" data-del>삭제</button>' : ''}
      </form>`}
      <p class="error" data-err></p>
      ${p.keyOf ? '' : `<p class="muted" style="font-size:12px;margin:0 0 10px">키 발급: <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${esc(p.keyUrl.replace('https://', ''))}</a></p>`}
      ${p.hasKey ? `<label style="margin:0">모델<select data-model><option>${esc(p.model)}</option></select></label>` : ''}
    </div>`).join('')}
  </div>`;

  document.querySelectorAll('[data-prov]').forEach((card) => {
    const id = card.dataset.prov;
    const p = ai.providers.find((x) => x.id === id);
    const err = $('[data-err]', card);
    $('[data-keyform]', card)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const apiKey = e.target.apiKey.value.trim();
      if (!apiKey) { err.textContent = '키를 입력해 주세요.'; return; }
      const btn = $('[data-save]', card);
      btn.disabled = true; btn.textContent = '연결 확인 중…'; err.textContent = '';
      try {
        await api(`/api/me/ai/keys/${id}`, { method: 'PUT', body: { apiKey } });
        toast(`${p.label} 키를 저장했습니다.`); renderSettings();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = p.hasKey ? '키 바꾸기' : '확인 후 저장'; }
    });
    $('[data-del]', card)?.addEventListener('click', async () => {
      if (!confirm(`${p.label} 키를 삭제할까요?`)) return;
      await api(`/api/me/ai/keys/${id}`, { method: 'DELETE' }); toast('키를 삭제했습니다.'); renderSettings();
    });
    $('[data-use]', card)?.addEventListener('click', async () => {
      await api('/api/me/ai/active', { method: 'PUT', body: { provider: id } });
      toast(p.hasKey ? `이제 ${p.label} 로 답합니다.` : `${p.label} 키가 없어 데모 응답이 나옵니다.`); renderSettings();
    });
    const sel = $('[data-model]', card);
    if (sel) {
      api(`/api/me/ai/models/${id}`).then(({ models }) => {
        const list = models.includes(p.model) ? models : [p.model, ...models];
        sel.innerHTML = list.map((m) => `<option ${m === p.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
      }).catch((ex) => { err.textContent = ex.message; });
      sel.addEventListener('change', async () => {
        try {
          state.info.ai = await api('/api/me/ai/active', { method: 'PUT', body: { provider: id, model: sel.value } });
          toast(`${sel.value} 로 바꿨고, 이제 이 AI 를 씁니다.`); renderSettings();
        } catch (ex) { toast(ex.message); }
      });
    }
  });
}

// ---------- 시작 ----------
async function boot() {
  try {
    const r = await api('/api/auth/me');
    state.me = r.user; state.info = r;
  } catch { return showAuth(); }
  $('#auth').classList.add('hidden'); $('#main').classList.remove('hidden');
  $('#me-name').textContent = state.me.name;
  $('#me-name').title = state.me.email;
  await loadSidebar();
  route();
}
boot();
