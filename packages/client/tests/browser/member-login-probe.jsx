import { useMemo, useState } from 'react';
import { createIdentityApi, MemberSessionBoundary } from '../../src/identity/index.js';

// Contract-only entry. It uses the real transport; tests intercept HTTP replies explicitly.
// No account import, session issuer, authorization directory or production entry is installed.
function MemberContent({ session, invalidate }) {
  const [draft, setDraft] = useState('');
  return (
    <section style={{ padding: 24 }} data-testid="member-content">
      <h2>会话契约预览</h2>
      <p>已恢复账号：{session.accountId}</p>
      <label>
        临时工作内容
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <button onClick={invalidate}>报告会话失效</button>
    </section>
  );
}
export function MemberLoginProbe() {
  const api = useMemo(() => createIdentityApi(), []);
  const [mounted, setMounted] = useState(true);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <nav aria-label="契约预览控制">
        <button onClick={() => setMounted(!mounted)}>
          {mounted ? '卸载登录入口' : '重新打开登录入口'}
        </button>
      </nav>
      <div style={{ flex: 1, minHeight: 0 }}>
        {mounted && (
          <MemberSessionBoundary api={api}>
            {(session, invalidate) => <MemberContent session={session} invalidate={invalidate} />}
          </MemberSessionBoundary>
        )}
      </div>
    </div>
  );
}
