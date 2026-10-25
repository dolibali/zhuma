import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityApiError } from '../dist/identity/api.js';
import {
  MemberSessionBoundary,
  MemberSessionView,
} from '../dist/identity/MemberSessionBoundary.js';
import { MemberSpaceBoundary } from '../dist/identity/MemberSpaceBoundary.js';

function markup(state) {
  return renderToStaticMarkup(
    createElement(
      MemberSessionView,
      { state, login() {}, retry() {}, logout() {} },
      'protected-content',
    ),
  );
}

test('space static component contract: authorization is rechecked before any business child mounts', () => {
  const html = renderToStaticMarkup(
    createElement(MemberSpaceBoundary, {
      api: {
        session() {
          assert.fail('render must not issue requests');
        },
      },
      session: {
        accountId: 'member-a',
        principal: { kind: 'zhuma-member', memberId: 'member-a' },
        peerId: 'request-peer',
        spaces: [{ id: 'team-a', kind: 'team', name: 'Product' }],
      },
      onUnauthenticated() {},
      children: () => 'protected-space-content',
    }),
  );
  assert.equal(html.includes('protected-space-content'), false);
  assert.match(html, /正在确认空间访问权限/);
});

for (const [status, caption, busy] of [
  ['ready', '研发协作空间', false],
  ['refreshing', '研发协作空间', true],
  ['checking', '正在确认空间…', true],
  ['empty', '尚未分配空间', false],
  ['error', '选择空间', false],
]) {
  test(`space entry static contract: ${status} has an honest name, accessible refresh and protected-content boundary`, () => {
    const space = { id: 'team-a', kind: 'team', name: '研发协作空间' };
    const session = {
      accountId: 'member-a',
      principal: { kind: 'zhuma-member', memberId: 'member-a' },
      peerId: 'request-local',
      spaces: status === 'empty' ? [] : [space],
    };
    const ready = status === 'ready' || status === 'refreshing';
    const state = {
      session,
      epoch: 2,
      status: ready ? 'ready' : status,
      ...(ready ? { space, refreshing: status === 'refreshing' } : {}),
      ...(status === 'error' ? { error: new IdentityApiError('unavailable') } : {}),
    };
    const unexpected = () =>
      assert.fail('Rendering the entry must not start any request or command');
    const html = renderToStaticMarkup(
      createElement(MemberSpaceBoundary, {
        api: { session: unexpected },
        session,
        onUnauthenticated: unexpected,
        controller: {
          getSnapshot: () => state,
          subscribe: () => () => {},
          refresh: unexpected,
          select: unexpected,
          invalidate: unexpected,
          dispose: unexpected,
        },
        children: () => 'protected-space-content',
      }),
    );
    assert.match(html, /aria-label="当前空间"/);
    assert.ok(html.includes(caption));
    const refresh = html.match(/<button[^>]*aria-label="刷新空间"[^>]*>/)?.[0];
    assert.ok(refresh, 'The icon-only refresh must have a stable accessible name');
    assert.equal(refresh.includes('aria-busy="true"'), busy);
    assert.equal(refresh.includes('disabled=""'), busy);
    assert.equal(html.includes('protected-space-content'), ready);
    assert.equal(html.includes('zm-space-summary'), false);
    if (ready) assert.match(html, /title="团队 · 研发协作空间"/);
    if (status === 'error') assert.match(html, /重新连接/);
    if (status === 'empty') assert.match(html, /请联系管理员分配个人或团队空间/);
  });
}

test('identity static component contract: labelled native login form supports password managers and errors', () => {
  const html = markup({ status: 'signed-out', error: new IdentityApiError('invalid-login') });
  assert.match(html, /<form/);
  assert.match(html, /autoComplete="username"/);
  assert.match(html, /autoComplete="current-password"/);
  assert.match(html, /type="password"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /<label for=/);
  assert.equal(html.includes('protected-content'), false);
  assert.match(markup({ status: 'signing-in' }), /<fieldset disabled=/);
});

test('identity static component contract: protected content appears only for the authenticated state', () => {
  for (const state of [
    { status: 'restoring' },
    { status: 'signing-out' },
    { status: 'unavailable', action: 'logout', error: new IdentityApiError('unavailable') },
  ]) {
    assert.equal(markup(state).includes('protected-content'), false);
  }
  const html = markup({
    status: 'authenticated',
    epoch: 1,
    session: {
      accountId: '<member-a>',
      principal: { kind: 'zhuma-member', memberId: '<member-a>' },
      peerId: 'peer-a',
      spaces: [],
    },
  });
  assert.match(html, /当前账号/);
  assert.match(html, /&lt;member-a&gt;/);
  assert.match(html, /退出登录/);
  assert.match(html, /protected-content/);
});

test('identity static component contract: boundary construction neither calls transport nor mounts protected children', () => {
  const unexpected = () => {
    throw Error('No transport or child render during static construction.');
  };
  const html = renderToStaticMarkup(
    createElement(MemberSessionBoundary, {
      api: { login: unexpected, session: unexpected, logout: unexpected },
      children: unexpected,
    }),
  );
  assert.match(html, /正在恢复登录/);
});
