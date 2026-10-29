import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../workbench/Button.js';
import { Field, Modal } from '../workbench/controls.js';
import type { MemberShell } from './shell.js';
import { changePasswordAndInvalidate } from './password-change.js';
import {
  createIdentityLifecycleApi,
  IdentityLifecycleError,
  type MemberTeam,
  type TeamMembers,
} from './lifecycle-api.js';

export function AccountTeamsDialog({
  shell,
  close,
  fetcher = globalThis.fetch,
}: {
  shell: MemberShell;
  close(): void;
  fetcher?: typeof fetch;
}) {
  const snapshot = useSyncExternalStore(shell.subscribe, shell.getSnapshot, shell.getSnapshot);
  const account = snapshot.session.status === 'authenticated' ? snapshot.session : undefined;
  const initialAccount = useRef(account);
  const sameAccount =
    account &&
    initialAccount.current &&
    account.epoch === initialAccount.current.epoch &&
    account.session.accountId === initialAccount.current.session.accountId;
  const api = useMemo(() => createIdentityLifecycleApi(fetcher), [fetcher]);
  const [tab, setTab] = useState<'teams' | 'password'>('teams');
  const [teams, setTeams] = useState<readonly MemberTeam[]>([]);
  const [selected, setSelected] = useState<string>();
  const [members, setMembers] = useState<TeamMembers>();
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [removing, setRemoving] = useState<string>();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController>();
  const createRequest = useRef(crypto.randomUUID());
  const memberRequest = useRef(crypto.randomUUID());
  const current = () => {
    const now = shell.session.getSnapshot();
    return (
      !!account &&
      now.status === 'authenticated' &&
      now.epoch === account.epoch &&
      now.session.accountId === account.session.accountId
    );
  };
  async function perform(work: (signal: AbortSignal) => Promise<void>) {
    if (active.current || !current()) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && current()) {
        if (error instanceof IdentityLifecycleError && error.code === 'unauthenticated')
          shell.session.invalidate(account!.epoch);
        else
          setError(
            error instanceof IdentityLifecycleError
              ? error.message
              : '操作未确认，请重新连接后检查。',
          );
      }
    } finally {
      if (active.current === controller) active.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function readTeams(signal: AbortSignal) {
    const value = await api.teams(signal);
    signal.throwIfAborted();
    if (!current() || value.accountId !== account!.session.accountId)
      throw new IdentityLifecycleError('unavailable');
    setTeams(value.teams);
    return value.teams;
  }
  async function readMembers(spaceId: string, signal: AbortSignal) {
    const value = await api.members(spaceId, signal);
    signal.throwIfAborted();
    if (current()) {
      setSelected(spaceId);
      setMembers(value);
      setRemoving(undefined);
    }
  }
  useEffect(() => {
    if (!sameAccount) {
      close();
      return;
    }
    void perform(async (signal) => {
      await readTeams(signal);
    });
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, [api, account?.epoch]);
  if (!account || !sameAccount) return null;
  const administrator = members?.administratorId === account.session.accountId;
  const controlsDisabled = busy || !administrator;
  return (
    <Modal title="账号与团队" close={close}>
      <div className="zhuma zm-form-body zm-account-management">
        <nav className="zm-tabs" aria-label="账号管理">
          <button
            aria-current={tab === 'teams' ? 'page' : undefined}
            onClick={() => setTab('teams')}
          >
            团队
          </button>
          <button
            aria-current={tab === 'password' ? 'page' : undefined}
            onClick={() => setTab('password')}
          >
            修改密码
          </button>
        </nav>
        {error && (
          <p role="alert" className="zm-login-error">
            {error}
          </p>
        )}
        {tab === 'teams' ? (
          <>
            <form
              className="zm-team-create"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async (signal) => {
                  const created = await api.createTeam(
                    { requestId: createRequest.current, name },
                    signal,
                  );
                  await readTeams(signal);
                  await readMembers(created.spaceId, signal);
                  await shell.space?.refresh();
                  if (!signal.aborted && current()) {
                    setName('');
                    createRequest.current = crypto.randomUUID();
                  }
                });
              }}
            >
              <Field label="新建团队">
                <input
                  required
                  maxLength={160}
                  placeholder="团队名称"
                  value={name}
                  disabled={busy}
                  onChange={(event) => {
                    setName(event.target.value);
                    createRequest.current = crypto.randomUUID();
                  }}
                />
              </Field>
              <Button type="submit" busy={busy}>
                创建团队
              </Button>
            </form>
            <div className="zm-team-directory">
              <div className="zm-team-list" aria-label="我的团队">
                {teams.map((team) => (
                  <button
                    key={team.id}
                    disabled={busy}
                    aria-current={selected === team.id ? 'true' : undefined}
                    onClick={() => void perform((signal) => readMembers(team.id, signal))}
                  >
                    <strong>{team.name}</strong>
                    <small>{team.role === 'administrator' ? '管理员' : '成员'}</small>
                  </button>
                ))}
                {!teams.length && !busy && <p className="zm-muted">尚未加入团队</p>}
              </div>
              <section className="zm-team-members" aria-label="团队成员">
                {members ? (
                  <>
                    <h3>{teams.find((team) => team.id === members.spaceId)?.name}</h3>
                    {members.administratorId === null && (
                      <p className="zm-muted">此团队尚未设置管理员，成员列表为只读。</p>
                    )}
                    {members.accountIds.map((id) => (
                      <div className="zm-team-member" key={id}>
                        <span>
                          {id}
                          {id === members.administratorId && <small>管理员</small>}
                        </span>
                        {administrator &&
                          id !== members.administratorId &&
                          (removing === id ? (
                            <span className="zm-actions">
                              <Button
                                variant="danger"
                                busy={busy}
                                onClick={() =>
                                  void perform(async (signal) => {
                                    await api.setMember(
                                      {
                                        requestId: memberRequest.current,
                                        spaceId: members.spaceId,
                                        accountId: id,
                                        action: 'remove',
                                      },
                                      signal,
                                    );
                                    await readMembers(members.spaceId, signal);
                                    memberRequest.current = crypto.randomUUID();
                                  })
                                }
                              >
                                确认移除
                              </Button>
                              <Button
                                variant="quiet"
                                disabled={busy}
                                onClick={() => setRemoving(undefined)}
                              >
                                取消
                              </Button>
                            </span>
                          ) : (
                            <Button
                              variant="quiet"
                              disabled={busy}
                              onClick={() => {
                                setRemoving(id);
                                memberRequest.current = crypto.randomUUID();
                              }}
                            >
                              移除
                            </Button>
                          ))}
                      </div>
                    ))}
                    {administrator && (
                      <form
                        className="zm-team-add"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void perform(async (signal) => {
                            await api.setMember(
                              {
                                requestId: memberRequest.current,
                                spaceId: members.spaceId,
                                accountId: target,
                                action: 'add',
                              },
                              signal,
                            );
                            await readMembers(members.spaceId, signal);
                            if (!signal.aborted && current()) {
                              setTarget('');
                              memberRequest.current = crypto.randomUUID();
                            }
                          });
                        }}
                      >
                        <Field label="添加已有账号">
                          <input
                            required
                            maxLength={64}
                            pattern={'[A-Za-z0-9_\\-]+'}
                            placeholder="成员账号"
                            disabled={controlsDisabled}
                            value={target}
                            onChange={(event) => {
                              setTarget(event.target.value);
                              memberRequest.current = crypto.randomUUID();
                            }}
                          />
                        </Field>
                        <Button type="submit" busy={busy} disabled={controlsDisabled}>
                          添加成员
                        </Button>
                      </form>
                    )}
                  </>
                ) : (
                  <p className="zm-muted">选择团队查看成员</p>
                )}
              </section>
            </div>
          </>
        ) : (
          <form
            className="zm-password-change"
            onSubmit={(event) => {
              event.preventDefault();
              if (newPassword !== confirmPassword) {
                setError('两次输入的新密码不一致。');
                return;
              }
              void perform(async (signal) => {
                const changed = await changePasswordAndInvalidate(
                  api,
                  { oldPassword, newPassword },
                  signal,
                  shell.session,
                  { accountId: account.session.accountId, epoch: account.epoch },
                  () => {
                    setOldPassword('');
                    setNewPassword('');
                    setConfirmPassword('');
                  },
                );
                if (changed) close();
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend className="zm-sr-only">修改密码</legend>
              <Field label="当前密码">
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={200}
                  value={oldPassword}
                  onChange={(event) => setOldPassword(event.target.value)}
                />
              </Field>
              <Field label="新密码">
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={200}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>
              <Field label="确认新密码">
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={200}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </Field>
            </fieldset>
            <p className="zm-muted">修改后需要重新登录。</p>
            <Button type="submit" variant="primary" busy={busy}>
              保存并重新登录
            </Button>
          </form>
        )}
      </div>
    </Modal>
  );
}
