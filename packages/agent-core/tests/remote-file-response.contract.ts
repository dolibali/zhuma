import type { z } from 'zod';
import type {
  RemoteRunScope,
  RemoteRunOperationValue,
  RemoteFileReservationValue,
  remoteRunValueSchemas,
} from '../src/remote-run-contract.js';

declare const scope: RemoteRunScope;
const absent = { scope, idempotencyKey: 'key', status: 'absent' } as const;
const released = {
  scope,
  idempotencyKey: 'key',
  reservationId: 'reservation',
  maximumBytes: 3,
  status: 'released',
} as const;
export const publishAbsent: RemoteRunOperationValue<'publish-file'> = absent;
export const statusAbsent: RemoteRunOperationValue<'file-status'> = absent;
export const publishReleased: RemoteRunOperationValue<'publish-file'> = released;
export const statusReleased: RemoteRunOperationValue<'file-status'> = released;
export const abandonReleased: RemoteRunOperationValue<'abandon-file'> = released;
export const reservationReleased: RemoteFileReservationValue = released;

const oldUpload = {
  scope,
  uploadId: 'upload',
  idempotencyKey: 'key',
  status: 'abandoned',
} as const;
// @ts-expect-error The old upload DTO cannot acknowledge an ephemeral reservation release.
export const abandonOldUpload: RemoteRunOperationValue<'abandon-file'> = oldUpload;
// @ts-expect-error An absent lookup is not a reservation-release acknowledgement.
export const abandonAbsent: RemoteRunOperationValue<'abandon-file'> = absent;
const reserved = { ...released, status: 'reserved' } as const;
// @ts-expect-error A still-reserved slot cannot acknowledge release.
export const abandonReserved: RemoteRunOperationValue<'abandon-file'> = reserved;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
export type PublishMatches = Expect<
  Equal<
    RemoteRunOperationValue<'publish-file'>,
    z.infer<(typeof remoteRunValueSchemas)['publish-file']>
  >
>;
export type StatusMatches = Expect<
  Equal<
    RemoteRunOperationValue<'file-status'>,
    z.infer<(typeof remoteRunValueSchemas)['file-status']>
  >
>;
export type AbandonMatches = Expect<
  Equal<
    RemoteRunOperationValue<'abandon-file'>,
    z.infer<(typeof remoteRunValueSchemas)['abandon-file']>
  >
>;
