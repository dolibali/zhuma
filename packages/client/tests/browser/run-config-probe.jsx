// Fixture-only API: no Host, CLI, models, workspace access or persisted business state.
import { useMemo } from 'react';
import { NativeRunLauncher } from '../../src/run/NativeRunWorkspace.js';
import styles from '../../src/run/NativeRunPanel.css';

export function RunConfigProbe() {
  const target = {
    spaceId: 'space',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    title: '运行配置契约',
  };
  const api = useMemo(() => {
    const unconfigured = new URL(location.href).searchParams.has('unconfigured');
    const model = { provider: 'local', model: 'ordinary', maxTokens: 4096 };
    const cli = { provider: 'acp-zhuma-codearts', model: 'inherited', maxTokens: 4096 };
    const executor = { kind: 'builtin' };
    const fixture = { reads: 0, commands: [], starts: [] };
    window.runConfigFixture = fixture;
    return {
      options: async () => {
        fixture.reads++;
        return {
          target,
          nodeVersion: 1,
          runVersion: 0,
          currentRunId: null,
          selection: unconfigured ? null : { model, executor, workspace: { kind: 'text-only' } },
          models: {
            kind: 'ready',
            items: unconfigured
              ? []
              : [
                  { id: 'ordinary', label: '普通模型', value: model },
                  { id: 'cli', label: 'CodeArts · 继承码道当前配置（开始时解析）', value: cli },
                ],
          },
          experts: [{ id: 'builtin', label: '内置 Agent', description: '', value: executor }],
          resources: [],
          workspaces: [],
          start: { kind: 'available', mode: 'begin' },
          tools: 'text-only',
        };
      },
      begin: async (request) => {
        fixture.starts.push(request);
        throw Error('Fixture captures the request without starting a model.');
      },
      codeArtsSetup: {
        status: async () => ({ configured: !unconfigured }),
        configure: async (command) => {
          fixture.commands.push(command);
        },
      },
    };
  }, []);
  return (
    <div className="zhuma">
      <style>{styles}</style>
      <NativeRunLauncher api={api} target={target} />
    </div>
  );
}
