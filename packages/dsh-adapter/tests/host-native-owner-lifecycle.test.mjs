/** In-process lifecycle contracts. Fake native ports do not certify SDK drain. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHostNativeOwnerLifecycle,
  HostNativeOpenRefusal,
} from '../dist/host-native-owner-lifecycle.js';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise(setImmediate);
function setup() {
  const trace = [];
  let origin = null,
    auth = false,
    listener,
    can = true,
    close = async () => {},
    openRemote;
  const source = {
    lookupNativeSession: () => null,
    canSwitchBackend() {
      trace.push('idle');
      return can;
    },
    async close() {
      trace.push('close');
      await close();
    },
    async dispose() {
      trace.push('dispose');
    },
  };
  const backend = {
    status: async () => ({ origin }),
    hasNativeAuthentication: async () => auth,
    onNativeAuthenticationChanged(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  };
  const remote = { ...source, lookupNativeSession: () => ({}) };
  const errors = [];
  const lifecycle = createHostNativeOwnerLifecycle({
    backend,
    async openLocal() {
      trace.push('open-local');
      return source;
    },
    async openRemote() {
      trace.push('open-remote');
      return openRemote ? openRemote() : remote;
    },
    failed: (error) => errors.push(error),
  });
  return {
    lifecycle,
    source,
    remote,
    trace,
    errors,
    setCan: (value) => {
      can = value;
    },
    setClose: (value) => {
      close = value;
    },
    setRemoteOpen: (value) => {
      openRemote = value;
    },
    select(value) {
      origin = value;
      auth = !!value;
    },
    event: (kind) => listener?.(kind),
  };
}
test('native selection: check/gate precede close/dispose and only then commit/open the selected child', async () => {
  const h = setup();
  await h.lifecycle.start();
  assert.equal(h.lifecycle.current(), h.source);
  const blocked = deferred();
  h.setClose(() => blocked.promise);
  const preparing = h.lifecycle.prepare();
  assert.equal(
    h.lifecycle.current(),
    undefined,
    'Admission closes synchronously before the first await',
  );
  assert.deepEqual(h.trace, ['open-local', 'idle', 'close']);
  await assert.rejects(h.lifecycle.prepare());
  blocked.resolve();
  const transition = await preparing;
  assert.deepEqual(h.trace, ['open-local', 'idle', 'close', 'dispose']);
  h.trace.push('commit');
  h.select('http://member.invalid');
  await transition.committed();
  assert.deepEqual(h.trace, ['open-local', 'idle', 'close', 'dispose', 'commit', 'open-remote']);
  assert.equal(h.lifecycle.current(), h.remote);
  await h.lifecycle.close();
});

test('native reconnect: a disposed failed first open stays fenced until original authentication changes', async () => {
  const h = setup();
  h.select('http://member.invalid');
  h.setRemoteOpen(async () => {
    throw new HostNativeOpenRefusal(Error('synthetic initial backend unavailable'));
  });
  await assert.rejects(h.lifecycle.start(), HostNativeOpenRefusal);
  assert.equal(h.lifecycle.current(), undefined);
  await tick();
  assert.equal(
    h.trace.filter((step) => step === 'open-remote').length,
    1,
    'No automatic retry or passive read can open an owner',
  );
  h.setRemoteOpen(async () => h.remote);
  h.event('changed');
  await tick();
  await tick();
  assert.equal(h.lifecycle.current(), h.remote);
  assert.equal(h.trace.filter((step) => step === 'open-remote').length, 2);
  await h.lifecycle.close();
});

test('native reconnect: a new authentication waits for the failed opening to finish its certified disposal', async () => {
  const h = setup(),
    pending = deferred();
  h.select('http://member.invalid');
  h.setRemoteOpen(() => pending.promise);
  const opening = assert.rejects(h.lifecycle.start(), HostNativeOpenRefusal);
  await tick();
  h.event('changed');
  h.setRemoteOpen(async () => h.remote);
  await tick();
  assert.equal(h.lifecycle.current(), undefined);
  assert.equal(h.trace.filter((step) => step === 'open-remote').length, 1);
  pending.reject(new HostNativeOpenRefusal(Error('synthetic disposed old mount')));
  await opening;
  await tick();
  await tick();
  assert.equal(h.lifecycle.current(), h.remote);
  assert.equal(h.trace.filter((step) => step === 'open-remote').length, 2);
  await h.lifecycle.close();
});

test('native reconnect: a verified restored session repairs only the clean failed owner and never restarts a healthy owner', async () => {
  const h = setup();
  h.select('http://member.invalid');
  h.setRemoteOpen(async () => {
    throw new HostNativeOpenRefusal(Error('synthetic disposed offline mount'));
  });
  await assert.rejects(h.lifecycle.start(), HostNativeOpenRefusal);
  h.setRemoteOpen(async () => h.remote);
  h.event('verified');
  await tick();
  await tick();
  assert.equal(h.lifecycle.current(), h.remote);
  const before = [...h.trace];
  h.event('verified');
  h.event('verified');
  await tick();
  assert.equal(h.lifecycle.current(), h.remote);
  assert.deepEqual(h.trace, before, 'Healthy session reads cannot close, dispose or remount');
  await h.lifecycle.close();
});

test('native reconnect: an unconfirmed opening or cleanup failure cannot certify a replacement', async () => {
  const h = setup();
  h.select('http://member.invalid');
  h.setRemoteOpen(async () => {
    throw Error('synthetic physical disposal unknown');
  });
  await assert.rejects(h.lifecycle.start());
  h.setRemoteOpen(async () => h.remote);
  h.event('verified');
  h.event('changed');
  await tick();
  await tick();
  assert.equal(h.lifecycle.current(), undefined);
  assert.equal(h.trace.filter((step) => step === 'open-remote').length, 1);
  await assert.rejects(h.lifecycle.prepare());
  await h.lifecycle.close();
});

test('native reconnect: closing while a failed opening drains prevents later authentication from reopening', async () => {
  const h = setup(),
    pending = deferred();
  h.select('http://member.invalid');
  h.setRemoteOpen(() => pending.promise);
  const opening = assert.rejects(h.lifecycle.start(), HostNativeOpenRefusal);
  await tick();
  const closing = assert.rejects(h.lifecycle.close(), HostNativeOpenRefusal);
  h.event('changed');
  pending.reject(new HostNativeOpenRefusal(Error('synthetic disposed after close')));
  await Promise.all([opening, closing]);
  h.event('changed');
  await tick();
  assert.equal(h.lifecycle.current(), undefined);
  assert.equal(h.trace.filter((step) => step === 'open-remote').length, 1);
});
test('native selection: busy or missing original idle metadata preserves the old child with zero close/dispose', async () => {
  for (const missing of [false, true]) {
    const h = setup();
    await h.lifecycle.start();
    if (missing) delete h.source.canSwitchBackend;
    else h.setCan(false);
    await assert.rejects(h.lifecycle.prepare(), { code: 'native-busy' });
    assert.equal(h.lifecycle.current(), h.source);
    assert.equal(h.trace.includes('close'), false);
    assert.equal(h.trace.includes('dispose'), false);
    await h.lifecycle.close();
  }
});
test('native selection: a failed drain retains the old obligation and never mounts a replacement', async () => {
  const h = setup();
  await h.lifecycle.start();
  h.setClose(async () => {
    throw Error('synthetic physical drain unknown');
  });
  await assert.rejects(h.lifecycle.prepare());
  assert.equal(h.lifecycle.current(), undefined);
  await assert.rejects(h.lifecycle.prepare());
  h.select('http://member.invalid');
  h.event('changed');
  await tick();
  assert.equal(h.trace.includes('open-remote'), false);
  await assert.rejects(h.lifecycle.close());
});
test('native selection: logout fences immediately and a newer login waits for the same real drain', async () => {
  const h = setup();
  await h.lifecycle.start();
  const drain = deferred();
  h.setClose(() => drain.promise);
  h.event('revoking');
  assert.equal(h.lifecycle.current(), undefined);
  assert.equal(h.trace.at(-1), 'close');
  h.select('http://member.invalid');
  h.event('changed');
  assert.equal(h.trace.includes('open-remote'), false);
  drain.resolve();
  await tick();
  await tick();
  assert.equal(h.lifecycle.current(), h.remote);
  assert.equal(h.trace.filter((x) => x === 'close').length, 1);
  await h.lifecycle.close();
});

test('native selection: a concurrent old-account auth reply cannot remount its backend between drain and commit', async () => {
  const h = setup();
  h.select('http://old.invalid');
  await h.lifecycle.start();
  h.trace.length = 0;
  const transition = await h.lifecycle.prepare();
  h.event('changed');
  await tick();
  assert.equal(h.trace.includes('open-remote'), false);
  h.select('http://new.invalid');
  await transition.committed();
  assert.equal(h.trace.filter((value) => value === 'open-remote').length, 1);
  await h.lifecycle.close();
});
