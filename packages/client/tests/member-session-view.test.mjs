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
