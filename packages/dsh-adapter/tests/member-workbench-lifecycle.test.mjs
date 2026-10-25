import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemberWorkbenchHttp, applyMemberWorkbench } from '../dist/member-workbench-http.js';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import {
  setup,
  request,
  projectCommand,
  taskInput,
  signal,
  deferred,
} from './member-workbench-fixture.mjs';

async function identity(t) {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-member-http-close-'));
  const host = await startMemberWorkbenchHost(home);
  const cookie = await host.login('ann');
  t.after(async () => {
    await host.close();
    await rm(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.ctx.webServer.port}`;
  return { host, cookie, origin };
}
function mount(outer, f, patch = {}, stop = async () => {}) {
  const routes = new Map();
  const effects = [];
  let stops = 0;
  const ctx = {
    root: outer.host.ctx.root,
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path.split('/').at(-1), route);
          return async () => {
            stops++;
            await stop();
          };
        },
      },
    },
    effect(register) {
      effects.push(register());
    },
  };
  const options = {
    workbench: f.workbench,
    directory: () => f.directory,
    writer: () => f.directory,
    operations: f.operations,
    ...patch,
  };
  const handle = openMemberWorkbenchHttp(ctx, options);
  const make = (endpoint, payload) =>
    new Request(`${outer.origin}/api/zhuma-member/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: outer.cookie,
        host: new URL(outer.origin).host,
        origin: outer.origin,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'close-test',
        method: `zhuma-member/${endpoint}`,
        payload,
      }),
    });
  return {
    handle,
    routes,
    effects,
    ctx,
    options,
    get stops() {
      return stops;
    },
    make,
    call: (endpoint, payload) => routes.get(endpoint).fetch(make(endpoint, payload)),
  };
}
async function waitEntered(held, reply) {
  await Promise.race([
    held.promise,
    reply.then((response) => {
      throw Error(`request ended before held boundary: ${response.status}`);
    }),
  ]);
}
async function pending(promise) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
}

test('member HTTP close contract: a held catalog read drains, late calls are fenced before body access, repeated close/effect share one promise', async (t) => {
  const outer = await identity(t);
  const f = setup();
  const entered = deferred();
  const release = deferred();
  const mounted = mount(outer, f, {
    catalog: async () => {
      entered.resolve();
      await release.promise;
      return { experts: [], assets: [] };
    },
  });
  const reply = mounted.call('snapshot', { spaceId: 'north' });
  await waitEntered(entered, reply);
  const close = mounted.handle.close();
  assert.equal(mounted.handle.close(), close);
  assert.equal(mounted.effects[0](), close);
  await pending(close);
  const late = mounted.make('snapshot', { spaceId: 'north' });
  Object.defineProperty(late, 'body', {
    get() {
      throw Error('late body must not be read');
    },
  });
  assert.equal((await mounted.routes.get('snapshot').fetch(late)).status, 503);
  release.resolve();
  assert.equal((await (await reply).json()).result.error.code, 'cancelled');
  await close;
  assert.equal(mounted.stops, 3);
  assert.equal(f.writes, 0);
});

test('member HTTP close contract: held streaming body aborts without waiting for its deadline or creating intent/model work', async (t) => {
  const outer = await identity(t);
  const f = setup();
  const entered = deferred();
  let controller;
  const mounted = mount(outer, f);
  const body = new ReadableStream(
    {
      pull(value) {
        controller = value;
        entered.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request(`${outer.origin}/api/zhuma-member/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: outer.cookie,
      host: new URL(outer.origin).host,
      origin: outer.origin,
    },
    body,
    duplex: 'half',
  });
  const reply = mounted.routes.get('command').fetch(req);
  await waitEntered(entered, reply);
  await mounted.handle.close();
  assert.equal((await reply).status, 408);
  controller.close();
  assert.equal(f.writes, 0);
  assert.equal(f.intents.size, 0);
  assert.equal(f.audits.size, 0);
});

test('member HTTP close contract: model abort completes failed audit and reentrant close is idempotent; late output cannot write', async (t) => {
  const outer = await identity(t);
  const f = setup();
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task: taskInput() }), signal());
  const entered = deferred();
  const late = deferred();
  let reentrant;
  let mounted;
  mounted = mount(outer, f, {
    model: () => ({
      name: 'held-contract-model',
      generate: async (_s, _i, abort) => {
        abort.addEventListener(
          'abort',
          () => {
            reentrant = mounted.handle.close();
          },
          { once: true },
        );
        entered.resolve();
        return late.promise;
      },
    }),
  });
  const reply = mounted.call('plan', {
    spaceId: 'north',
    requestId: '00000000-0000-4000-8000-000000000001',
    taskId: 'task-one',
    expectedRevision: 2,
    instruction: '',
  });
  await waitEntered(entered, reply);
  const close = mounted.handle.close();
  assert.equal(reentrant, close);
  await close;
  assert.equal((await (await reply).json()).result.error.code, 'cancelled');
  assert.equal([...f.audits.values()][0].status, 'failed');
  const before = JSON.stringify([...f.audits.values()]);
  late.resolve('late invalid output');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify([...f.audits.values()]), before);
  assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
  assert.equal(mounted.stops, 3);
});

for (const boundary of ['workbench', 'outcome', 'failed-outcome']) {
  test(`member HTTP close durability contract: held ${boundary} keeps close pending and original request recovers without duplicate mutation`, async (t) => {
    const outer = await identity(t);
    const f = setup();
    const entered = deferred();
    const release = deferred();
    const write = f.storage.write;
    const complete = f.operations.complete.bind(f.operations);
    if (boundary === 'workbench')
      f.storage.write = async (value) => {
        entered.resolve();
        await release.promise;
        await write(value);
      };
    else
      f.operations.complete = async (intent, revision) => {
        entered.resolve();
        await release.promise;
        if (boundary === 'failed-outcome') throw Error('synthetic failed outcome');
        await complete(intent, revision);
      };
    const mounted = mount(outer, f);
    const input = request(0, projectCommand());
    const reply = mounted.call('command', input);
    await waitEntered(entered, reply);
    const close = mounted.handle.close();
    await pending(close);
    assert.equal(f.workbench.snapshot().revision, boundary === 'workbench' ? 0 : 1);
    release.resolve();
    await close;
    assert.equal((await (await reply).json()).result.error.code, 'cancelled');
    assert.equal(f.workbench.snapshot().revision, 1);
    f.storage.write = write;
    f.operations.complete = complete;
    f.reopen();
    const reopened = mount(outer, f);
    assert.equal((await (await reopened.call('command', input)).json()).result.ok, true);
    assert.equal(f.writes, 1);
    assert.equal(f.workbench.snapshot().projects.length, 1);
    await reopened.handle.close();
  });
}

test('member HTTP close failure contract: unregister failure is reported only after admitted work settles; no automatic domain close', async (t) => {
  const outer = await identity(t);
  const f = setup();
  const entered = deferred();
  const release = deferred();
  const mounted = mount(
    outer,
    f,
    {
      catalog: async () => {
        entered.resolve();
        await release.promise;
        return { experts: [], assets: [] };
      },
    },
    async () => {
      throw Error('PRIVATE_STOP_FAILURE');
    },
  );
  const reply = mounted.call('snapshot', { spaceId: 'north' });
  await waitEntered(entered, reply);
  const close = mounted.handle.close();
  await pending(close);
  release.resolve();
  await reply;
  await assert.rejects(close, /关闭失败/);
  assert.equal(mounted.handle.close(), close);
  assert.equal(f.workbench.snapshot().revision, 0);
  assert.equal((await mounted.call('snapshot', { spaceId: 'north' })).status, 503);
});

test('member HTTP Cordis wrapper contract: apply remains void and its disposer is awaitable', async (t) => {
  const outer = await identity(t);
  const f = setup();
  const mounted = mount(outer, f);
  await mounted.handle.close();
  const before = mounted.effects.length;
  assert.equal(applyMemberWorkbench(mounted.ctx, mounted.options), undefined);
  const closed = mounted.effects[before]();
  assert.equal(typeof closed.then, 'function');
  await closed;
});

test('member HTTP close intent contract: held intent finishes before close; cancelled pre-commit request can explicitly resume once', async (t) => {
  const outer = await identity(t);
  const f = setup();
  const entered = deferred();
  const release = deferred();
  const begin = f.operations.begin.bind(f.operations);
  f.operations.begin = async (intent) => {
    await begin(intent);
    entered.resolve();
    await release.promise;
  };
  const mounted = mount(outer, f);
  const input = request(0, projectCommand());
  const reply = mounted.call('command', input);
  await waitEntered(entered, reply);
  const close = mounted.handle.close();
  try {
    await pending(close);
    assert.equal(f.intents.size, 1);
    assert.equal(f.links.size, 0);
  } finally {
    release.resolve();
  }
  await close;
  assert.equal((await (await reply).json()).result.error.code, 'cancelled');
  assert.equal(f.writes, 0);
  assert.equal(f.links.size, 0);
  f.operations.begin = begin;
  const reopened = mount(outer, f);
  assert.equal((await (await reopened.call('command', input)).json()).result.ok, true);
  assert.equal(f.writes, 1);
  await reopened.handle.close();
});

test('member HTTP close real DSH/JSON contract: storage stays open until an admitted commit/outcome is stable, then same-disk retry is idempotent', async () => {
  for (const mode of ['handle', 'cordis']) {
    const home = await mkdtemp(join(tmpdir(), `zhuma-member-close-json-${mode}-`));
    const held = deferred();
    const release = deferred();
    let host;
    try {
      host = await startMemberWorkbenchHost(home, {
        beforeWorkbenchWrite: async () => {
          held.resolve();
          await release.promise;
        },
      });
      const cookie = await host.login('ann');
      const input = request(0, projectCommand());
      const reply = host.rpc('command', input, cookie);
      await Promise.race([
        held.promise,
        reply.then((value) => {
          throw Error(`request ended before durability: ${value.status}`);
        }),
      ]);
      const close = mode === 'handle' ? host.httpHandle.close() : host.httpFiber.dispose();
      await pending(close);
      assert.equal(host.service.snapshot().revision, 0);
      release.resolve();
      await close;
      assert.equal((await reply).json.result.error.code, 'cancelled');
      assert.equal(host.service.snapshot().revision, 1);
      await host.close();
      host = undefined;
      host = await startMemberWorkbenchHost(home);
      const restored = await host.rpc('command', input, await host.login('ann'));
      assert.equal(restored.json.result.ok, true);
      assert.equal(restored.json.result.value.state.revision, 1);
      assert.equal(restored.json.result.value.state.projects.length, 1);
    } finally {
      release.resolve();
      if (host) await host.close();
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('member HTTP partial-mount contract: failed registration fences old callbacks and awaits cleanup through its disposer', async () => {
  const f = setup();
  let first;
  let registrations = 0;
  let stopped = 0;
  const effects = [];
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          if (++registrations === 2) throw Error('PRIVATE_REGISTRATION_ERROR');
          first = route;
          return async () => {
            stopped++;
          };
        },
      },
    },
    effect(register) {
      effects.push(register());
    },
  };
  assert.throws(
    () =>
      openMemberWorkbenchHttp(ctx, {
        workbench: f.workbench,
        directory: () => f.directory,
        writer: () => f.directory,
        operations: f.operations,
      }),
    (error) => error.code === 'unavailable' && !error.message.includes('PRIVATE_'),
  );
  await effects[0]();
  const late = new Request('http://127.0.0.1/api/zhuma-member/snapshot');
  Object.defineProperty(late, 'body', {
    get() {
      throw Error('must stay fenced');
    },
  });
  assert.equal((await first.fetch(late)).status, 503);
  assert.equal(stopped, 1);
  assert.equal(f.writes, 0);
});
