// 모든 권한 판단은 여기서, 인증된 사용자 ID 기준으로 서버에서 한다.
// 화면에서 버튼을 숨기는 것과 무관하게 API 를 직접 호출해도 같은 검사를 거친다.

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// 존재 여부도 노출하지 않도록, 권한이 없으면 404 로 응답한다.
const notFound = () => new HttpError(404, '찾을 수 없거나 접근 권한이 없습니다.');
const forbidden = (msg = '권한이 없습니다.') => new HttpError(403, msg);

function makeAuthz(db) {
  const q = {
    member: db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'),
    project: db.prepare('SELECT * FROM projects WHERE id = ?'),
    conv: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    threadMember: db.prepare('SELECT permission FROM thread_members WHERE conversation_id = ? AND user_id = ?'),
    file: db.prepare('SELECT * FROM files WHERE id = ?'),
    fileShare: db.prepare('SELECT 1 FROM file_shares WHERE file_id = ? AND user_id = ?'),
  };

  /** 프로젝트 멤버인지. 아니면 404. */
  function project(userId, projectId) {
    const p = q.project.get(projectId);
    if (!p) throw notFound();
    const m = q.member.get(projectId, userId);
    if (!m) throw notFound();
    return { project: p, role: m.role };
  }

  function projectOwner(userId, projectId) {
    const r = project(userId, projectId);
    if (r.role !== 'owner') throw forbidden('프로젝트 소유자만 할 수 있습니다.');
    return r;
  }

  /**
   * 대화(개인 대화 또는 프로젝트 스레드)에 대한 권한.
   * 반환 permission: owner | participate | read. 접근 불가면 404.
   */
  function conversation(userId, convId) {
    const c = q.conv.get(convId);
    if (!c) throw notFound();
    if (c.project_id == null) {
      // 개인 AI 대화: 본인만
      if (c.owner_id !== userId) throw notFound();
      return { conv: c, permission: 'owner' };
    }
    // 프로젝트 스레드: 프로젝트 멤버여야 하고, 만든 사람 또는 공유받은 사람만
    if (!q.member.get(c.project_id, userId)) throw notFound();
    if (c.owner_id === userId) return { conv: c, permission: 'owner' };
    const tm = q.threadMember.get(convId, userId);
    if (!tm) throw notFound();
    return { conv: c, permission: tm.permission };
  }

  /** 메시지 작성·AI 질문 가능 여부 (참여 이상) */
  /** 스레드를 만든 사람만 (공유 설정 등) */
  function conversationOwner(userId, convId) {
    const r = conversation(userId, convId);
    if (r.permission !== 'owner') throw forbidden('스레드를 만든 사람만 할 수 있습니다.');
    return r;
  }

  /** 지금 그 프로젝트 멤버인지 (공유·초대 대상 확인용) */
  function isMember(projectId, userId) { return !!q.member.get(projectId, userId); }

  function conversationWrite(userId, convId) {
    const r = conversation(userId, convId);
    if (r.permission === 'read') throw forbidden('읽기 권한만 있어 메시지를 쓸 수 없습니다.');
    return r;
  }

  /**
   * 파일 열람 권한.
   * 개인 파일: 올린 사람만. 프로젝트 파일: 지금 그 프로젝트 멤버여야 하고 (내보내지면 바로 차단),
   * 올린 사람이거나, 프로젝트 전체 공개이거나, 나에게 개별 공유된 파일이어야 한다.
   */
  function canReadFile(userId, f) {
    if (f.project_id == null) return f.owner_id === userId;
    if (!q.member.get(f.project_id, userId)) return false;
    if (f.owner_id === userId || f.visibility === 'project') return true;
    return !!q.fileShare.get(f.id, userId);
  }

  function file(userId, fileId) {
    const f = q.file.get(fileId);
    if (!f || !canReadFile(userId, f)) throw notFound();
    return f;
  }

  function fileOwner(userId, fileId) {
    const f = file(userId, fileId);
    if (f.owner_id !== userId) throw forbidden('파일을 올린 사람만 할 수 있습니다.');
    return f;
  }

  /**
   * 대화에서 AI 가 쓸 수 있는 파일인가.
   * 개인 대화: 본인 파일만. 프로젝트 스레드: 같은 프로젝트 파일이면서,
   * 그 스레드에 접근 가능한 "모든" 사람이 볼 수 있는 파일만 (공유 대화 원칙).
   */
  function fileUsableInConversation(conv, f) {
    if (conv.project_id == null) return f.owner_id === conv.owner_id && f.project_id == null;
    if (f.project_id !== conv.project_id) return false;
    const viewers = [conv.owner_id, ...db.prepare('SELECT user_id FROM thread_members WHERE conversation_id = ?')
      .all(conv.id).map((r) => r.user_id)];
    return viewers.every((uid) => canReadFile(uid, f));
  }

  return { project, projectOwner, conversation, conversationOwner, conversationWrite, isMember, file, fileOwner, canReadFile, fileUsableInConversation };
}

module.exports = { makeAuthz, HttpError, notFound, forbidden };
