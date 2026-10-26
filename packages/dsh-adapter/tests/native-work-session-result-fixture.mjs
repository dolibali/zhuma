/** Original Cookie/Run/SDK host fixture; scripted model selection remains a contract. */
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { bootRunFiles } from './native-work-session-files-fixture.mjs';
import { createNativeFixedResultIssuer } from '../dist/native-work-session-result.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
export { describeNativeResultTool };
export { allHistory, toolResponse } from './native-work-session-files-fixture.mjs';

export async function bootNativeResults(root, options = {}) {
  let results;
  let actor;
  let agentContext;
  const host = await bootRunFiles(root, {
    first: options.first ?? true,
    acceptedFiles: options.acceptedFiles,
    ...(options.complete === false ? {} : { resultIntentTool: describeNativeResultTool() }),
    composeExtra(ctx, binding, grant) {
      actor = scopeOf(ctx);
      agentContext = ctx;
      const registered =
        options.complete === false
          ? { context: '', toolAllowlist: [] }
          : results.registerNativeResultTool(ctx, binding, grant);
      options.configure?.(ctx, binding, grant, results);
      return registered;
    },
  });
  const native = await host.nativeSession();
  results = createNativeFixedResultIssuer(
    host.ctx,
    native.service,
    native.runtime,
    host.issuer,
    host.execution,
  );
  return {
    ...host,
    native,
    results,
    actor: () => actor,
    agentContext: () => agentContext,
    get snapshot() {
      return host.snapshot;
    },
  };
}
