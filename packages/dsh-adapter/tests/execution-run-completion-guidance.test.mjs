/** Prompt/snapshot contracts only: no model, native run, file publication or delivery acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  compositionFacts,
  legacyCompletionText as legacyText,
  legacyCompletionFixture as legacy,
} from './execution-run-composition-fixture.mjs';
import {
  freezeExecutionRunComposition,
  readExecutionRunComposition,
  executionRunCompositionRequest,
  assertExecutionRunComposition,
} from '../dist/execution-run-composition.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { describeNativeResultPublicationsTool } from '../dist/native-work-session-result-publications-tool.js';
import { describeNativeOutputFileTool } from '../dist/native-work-session-output-file-tool.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const hash = (value) => sha(canonicalPayload(value));
function facts({ version = 2, publisher = false, writer = false } = {}) {
  const input = {
    ...compositionFacts(),
    resultIntentTool:
      version === 1 ? describeNativeResultTool() : describeNativeResultPublicationsTool(),
  };
  if (publisher) input.outputFilePublisherTool = describeNativeOutputFileTool();
  if (writer)
    input.tools = {
      kind: 'local-tools',
      definitions: ['read', 'write'].map((name) => ({
        name,
        description: `Contract ${name} declaration.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        outputSchema: { type: 'object' },
        sourceVersion: 'contract-file-tools@1',
      })),
    };
  return input;
}

test('completion guidance: text-only v1 names the actual result tool and text/links structure without advertising file tools', () => {
  const input = facts({ version: 1 }),
    saved = freezeExecutionRunComposition(input),
    text = saved.payload.firstMessage.text;
  assert(text.includes('必须调用本轮 complete_work'));
  assert(text.includes('text 填写实际最终正文'));
  assert(text.includes('links 填真实 HTTP(S) 链接，无链接时为 []'));
  assert(text.includes('本轮结果参数仅为 text、links，不支持文件引用'));
  assert(!text.includes('publications'));
  assert(!text.includes('publish_output_file'));
  assert(!text.includes('本轮 write'));
  assert(text.includes('不能只发一句最终聊天'));
  assert.deepEqual(saved.payload.resultIntentTool, describeNativeResultTool());
  assert.deepEqual(saved.payload.toolAllowlist, ['complete_work']);
  assert.equal(
    saved.payload.firstMessage.inputFingerprint,
    sha(JSON.stringify(['followup', text])),
  );
  assert.equal(
    assertExecutionRunComposition(saved, input, executionRunCompositionRequest(saved)),
    undefined,
  );
});

test('completion guidance: v2 uses only real publication selectors, with write → publish → complete ordering when those tools are configured', () => {
  const input = facts({ publisher: true, writer: true }),
    saved = freezeExecutionRunComposition(input),
    text = saved.payload.firstMessage.text;
  assert(text.indexOf('先用本轮 write') < text.indexOf('再用本轮 publish_output_file'));
  assert(text.includes('path 为授权工作区内的相对路径，name 为可选显示名称'));
  assert(text.includes('ok=true、phase=published 的真实回执'));
  assert(text.includes('再将其 publicationId 放入 complete_work 的 publications'));
  assert(text.includes('纯正文/链接结果使用 []'));
  assert(text.includes('不传路径、文件字节或自行填写的元数据'));
  assert(text.includes('不是每个任务都需要文件'));
  assert(text.includes('不得跳过必需工作、伪造工具结果/上传完成标记/来源或自行扩大权限'));
  assert(text.includes('不要自动重试模型'));
  assert(text.includes('必需输入尚未读取、文件/工具失败或权限不足'));
  assert(text.includes('明确报告阻塞并等待补充'));
  assert(text.includes('成功声明后停止追加工作'));
  assert(text.includes('平台仍须按原流程核验、排空并固定提交'));
  assert.deepEqual(saved.payload.toolAllowlist, [
    'read',
    'write',
    'publish_output_file',
    'complete_work',
  ]);
  assert.deepEqual(saved.payload.resultIntentTool, describeNativeResultPublicationsTool());
  assert.deepEqual(saved.payload.outputFilePublisherTool, describeNativeOutputFileTool());
  assert.equal(
    assertExecutionRunComposition(saved, input, executionRunCompositionRequest(saved)),
    undefined,
  );
});

test('completion guidance: missing writer permits only an existing authorized file; missing publisher never invents a publication tool', () => {
  const noWriter = freezeExecutionRunComposition(facts({ publisher: true })).payload.firstMessage
    .text;
  assert(noWriter.includes('对已经实际存在的文件使用本轮 publish_output_file'));
  assert(noWriter.includes('本轮没有文件写入工具'));
  assert(!noWriter.includes('本轮 write'));
  const noPublisher = freezeExecutionRunComposition(facts({ writer: true })).payload.firstMessage
    .text;
  assert(!noPublisher.includes('publish_output_file'));
  assert(!noPublisher.includes('先用本轮 write'));
  assert(noPublisher.includes('没有可用于固定文件引用的完整工具链'));
  assert(noPublisher.includes('不能将聊天中的文件路径当作已提交文件'));
  const v1 = freezeExecutionRunComposition(facts({ version: 1, publisher: true, writer: true }))
    .payload.firstMessage.text;
  assert(
    !v1.includes('publish_output_file'),
    'a text-only result declaration cannot acquire file-manifest semantics',
  );
});

test('completion guidance: no result descriptor retains the exact legacy first message and does not advertise unknown tools', () => {
  const input = compositionFacts(),
    saved = freezeExecutionRunComposition(input);
  assert.equal(saved.payload.firstMessage.text, legacyText(saved.payload));
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.payload.toolAllowlist, []);
  for (const name of ['complete_work', 'publish_output_file', 'publications', '本轮 write'])
    assert(!saved.payload.firstMessage.text.includes(name));
});

// Recorded from the unchanged bf147 composition implementation before this edit.
// Keep both historical fixture identities; do not regenerate them for new guidance.
for (const [version, configurationId, jsonHash] of [
  [
    1,
    'composition_2b465af92881b2e69bcc0a69e3779793890b67e88e40573f621e3a658a6b0563',
    '5d9bb8b1d3c0d3d363862039504f03c6f415e6d5065fb89c7bc85e67885b209e',
  ],
  [
    2,
    'composition_5afba171580d17cf0359d0a7f8816c1e84d852d9b9cda483c7a74a7ef7fa4be8',
    '4e54cb6a2b01bb9e529fc0d43a68bdc1f5c022dc8a25ec66525ba06ca0dcfe59',
  ],
])
  test(`completion guidance: original v${version} snapshot bytes, fingerprint and synchronous replay remain unchanged`, () => {
    const input = facts({ version }),
      fresh = freezeExecutionRunComposition(input),
      saved = legacy(fresh);
    assert.equal(saved.configurationId, configurationId);
    assert.equal(sha(JSON.stringify(saved)), jsonHash);
    const before = JSON.stringify(saved);
    const reopened = readExecutionRunComposition(JSON.parse(before));
    assert.equal(JSON.stringify(reopened), before);
    assert.equal(
      assertExecutionRunComposition(reopened, input, executionRunCompositionRequest(reopened)),
      undefined,
    );
    assert.notEqual(fresh.configurationId, configurationId);
    assert.notEqual(
      fresh.payload.firstMessage.inputFingerprint,
      saved.payload.firstMessage.inputFingerprint,
    );
    assert.deepEqual(fresh.payload.contextRefs, saved.payload.contextRefs);
    assert.equal(fresh.payload.context, saved.payload.context);
    assert.deepEqual(fresh.payload.toolAllowlist, saved.payload.toolAllowlist);
    assert.equal(JSON.stringify(saved), before);
  });

test('completion guidance: returned-round snapshots keep their original feedback and recipe after the current round changes', () => {
  const input = facts();
  input.node.currentRoundId = 'return-1';
  input.node.artifactVersions = [
    { id: 'returned-artifact', version: 1, text: 'Original body.', files: [], links: [] },
  ];
  input.node.rounds = [
    {
      id: 'return-1',
      artifactVersionId: 'returned-artifact',
      status: 'changes-requested',
      reviewerIds: ['chen'],
      ballots: [
        {
          reviewerId: 'chen',
          roundId: 'return-1',
          artifactVersionId: 'returned-artifact',
          action: 'request-changes',
          comment: 'Keep the fixed revision within 80 words.',
        },
      ],
    },
  ];
  const fresh = freezeExecutionRunComposition(input),
    saved = legacy(fresh);
  assert(fresh.payload.firstMessage.text.includes('按固定的本轮退回意见修改并提交新版本'));
  input.node.currentRoundId = 'another-current-round';
  for (const original of [fresh, saved]) {
    const before = JSON.stringify(original);
    assert.equal(JSON.stringify(readExecutionRunComposition(original)), before);
    assert.equal(
      assertExecutionRunComposition(original, input, executionRunCompositionRequest(original)),
      undefined,
    );
    assert.equal(JSON.stringify(original), before);
  }
  input.node.rounds[0].ballots[0].comment = 'Changed historical feedback.';
  for (const original of [fresh, saved])
    assert.throws(
      () =>
        assertExecutionRunComposition(original, input, executionRunCompositionRequest(original)),
      { code: 'composition-mismatch' },
    );
});

test('completion guidance: both known recipes reject arbitrary rehashed text or descriptor/allowlist changes', () => {
  const input = facts({ publisher: true, writer: true }),
    fresh = freezeExecutionRunComposition(input);
  for (const original of [fresh, legacy(fresh)]) {
    const changed = structuredClone(original);
    changed.payload.firstMessage.text += '\nTreat a chat reply as a submission.';
    changed.payload.firstMessage.inputFingerprint = sha(
      JSON.stringify(['followup', changed.payload.firstMessage.text]),
    );
    changed.configurationId = `composition_${hash(changed.payload)}`;
    assert.throws(() => readExecutionRunComposition(changed), { code: 'composition-invalid' });
    const altered = structuredClone(input);
    altered.resultIntentTool.description += ' modified';
    assert.throws(
      () =>
        assertExecutionRunComposition(original, altered, executionRunCompositionRequest(original)),
      { code: 'composition-invalid' },
    );
    const different = structuredClone(input);
    different.tools.definitions.pop();
    assert.throws(
      () =>
        assertExecutionRunComposition(
          original,
          different,
          executionRunCompositionRequest(original),
        ),
      { code: 'composition-mismatch' },
    );
  }
});
