const stages = [
  'realpath',
  'policy',
  'start',
  'health',
  'create-session',
  'resume-session',
  'history',
] as const;
export type CodeArtsOpenStage = (typeof stages)[number];
const codes = [
  'not-installed',
  'start-failed',
  'start-timeout',
  'unsupported-version',
  'server-exited',
  'workspace-untrusted',
  'invalid-endpoint',
  'invalid-session',
  'cancelled',
  'rejected',
  'unavailable',
  'dispatch-unknown',
  'invalid-response',
  'response-too-large',
] as const;
export interface CodeArtsOpenDiagnostic {
  readonly stage: CodeArtsOpenStage | 'unknown';
  readonly code: (typeof codes)[number] | 'unknown';
  readonly httpStatus?: number;
}

/** Only fixed vocabulary crosses ACP. Never serialize an error or its cause. */
export function codeArtsOpenDiagnostic(
  stage: unknown,
  code: unknown = 'unknown',
  httpStatus?: unknown,
): CodeArtsOpenDiagnostic {
  return Object.freeze({
    stage: stages.find((value) => value === stage) ?? 'unknown',
    code: codes.find((value) => value === code) ?? 'unknown',
    ...(typeof httpStatus === 'number' &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 400 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
  });
}
