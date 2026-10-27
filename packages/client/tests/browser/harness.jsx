import { createRoot } from 'react-dom/client';
import { StrictMode, useState } from 'react';
import { SelectProbe } from './select-probe.jsx';
import { StartableProbe } from './startable-probe.jsx';
import { ExecutionProbe } from './execution-probe.jsx';
import { RevisionProbe } from './revision-probe.jsx';
import { UpstreamProbe } from './upstream-probe.jsx';
import { DeliveryDraftProbe } from './delivery-draft-probe.jsx';
import { InboxGroupsProbe } from './inbox-groups-probe.jsx';
import { MemberExecutionPage } from '../../src/execution/MemberExecutionPage.js';
import { MemberWorkbenchProbe } from './member-workbench-probe.jsx';
import { MemberLoginProbe } from './member-login-probe.jsx';
import { MemberSpacesProbe } from './member-spaces-probe.jsx';
import { MemberExecutionSpacesProbe } from './member-execution-spaces-probe.jsx';
import { createMemberAccountProbe } from './member-account-probe.jsx';
import { WorkbenchPage } from '../../src/workbench/WorkbenchPage.js';
import { createWorkbenchApi } from '../../src/workbench/api.js';
import styles from '../../src/workbench/workbench.css';
import flowStyles from '@xyflow/react/dist/style.css';

// Test doubles for the two official DSH service boundaries, never shipped in the product.
const api = createWorkbenchApi({
  async call(prefix, method, payload, signal) {
    const response = await fetch(`${prefix}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
      signal,
    });
    if (!response.ok) throw Error(`Fixture transport failed: ${response.status}`);
    return (await response.json()).result;
  },
});
let preference = 'system';
const subscribers = new Set();
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function reflectTheme() {
  document.body.toggleAttribute(
    'data-ds-dark-theme',
    preference === 'dark' || (preference === 'system' && systemTheme.matches),
  );
}
const appearance = {
  getSnapshot: () => preference,
  subscribe(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  set(next) {
    preference = next;
    reflectTheme();
    subscribers.forEach((listener) => listener());
  },
};
reflectTheme();
systemTheme.addEventListener('change', reflectTheme);
const style = document.createElement('style');
style.textContent = `${flowStyles}\n${styles}`;
document.head.append(style);
function MountProbe() {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button onClick={() => setMounted(false)}>切出工作台</button>
      <button onClick={() => setMounted(true)}>返回工作台</button>
      {mounted && <WorkbenchPage api={api} initialSection="tasks" appearance={appearance} />}
    </>
  );
}
const content = new URL(location.href).searchParams.has('member-account') ? (
  createMemberAccountProbe()
) : new URL(location.href).searchParams.has('startable-plans') ? (
  <StartableProbe />
) : new URL(location.href).searchParams.has('member-execution-spaces') ? (
  <MemberExecutionSpacesProbe />
) : new URL(location.href).searchParams.has('member-spaces') ? (
  <MemberSpacesProbe />
) : new URL(location.href).searchParams.has('member-workbench') ? (
  <MemberWorkbenchProbe appearance={appearance} />
) : new URL(location.href).searchParams.has('member-execution') ? (
  <MemberExecutionPage />
) : new URL(location.href).searchParams.has('execution-client') ? (
  <ExecutionProbe />
) : new URL(location.href).searchParams.has('revision-client') ? (
  <RevisionProbe />
) : new URL(location.href).searchParams.has('upstream-client') ? (
  <UpstreamProbe />
) : new URL(location.href).searchParams.has('delivery-drafts') ? (
  <DeliveryDraftProbe />
) : new URL(location.href).searchParams.has('inbox-groups') ? (
  <InboxGroupsProbe />
) : new URL(location.href).searchParams.has('member-login') ? (
  <MemberLoginProbe />
) : new URL(location.href).searchParams.has('mount-probe') ? (
  <MountProbe />
) : new URL(location.href).searchParams.has('select-probe') ? (
  <SelectProbe />
) : new URL(location.href).searchParams.has('expert-library') ? (
  <WorkbenchPage api={api} initialSection="assets" expertLibrary appearance={appearance} />
) : (
  <WorkbenchPage api={api} initialSection="tasks" appearance={appearance} />
);
createRoot(document.getElementById('root')).render(
  new URL(location.href).searchParams.has('strict') ? <StrictMode>{content}</StrictMode> : content,
);
