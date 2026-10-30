import { z } from 'zod';
import {
  REMOTE_RUN_LIMITS,
  remotePermitDeclarationSchema,
  remoteResultDeclarationSchema,
  remoteResultReceiptSchema,
  remoteInputDescriptorSchema,
  remoteWorkflowBindingSchema,
} from '@zhuma/agent-core';

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
export const remoteDeviceRecordSchema = z.strictObject({
  deviceId: z.uuid(),
  actorId: id,
  publicKey: z.string().min(40).max(128),
  keyEpoch: positive,
  displayName: z.string().min(1).max(80).optional(),
  requestId: z.uuid(),
  fingerprint: digest,
});
export const remoteBackendRegistrySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    backendId: z.uuid(),
    devices: z.array(remoteDeviceRecordSchema).max(REMOTE_RUN_LIMITS.devices),
  })
  .refine(
    (value) =>
      new Set(value.devices.map((device) => device.deviceId)).size === value.devices.length,
  );
export type RemoteBackendRegistry = z.infer<typeof remoteBackendRegistrySchema>;
const permit = remotePermitDeclarationSchema.extend({ epoch: z.uuid(), expiresAt: positive });
/** Hashes/metadata only in the ORIGINAL Run; local private credentials never enter this row. */
export const remoteRunBindingSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    workflow: remoteWorkflowBindingSchema.optional(),
    files: z.literal('zhuma-native-output-file@1').optional(),
    acceptedFiles: z.literal('zhuma-accepted-files@2').optional(),
    knowledge: z.literal('zhuma-native-knowledge@1').optional(),
    teamAssets: z.literal('zhuma-native-team-assets@1').optional(),
    backendId: z.uuid(),
    deviceId: z.uuid(),
    publicKey: z.string().min(40).max(128),
    keyEpoch: positive,
    acceptRequestId: z.uuid(),
    acceptFingerprint: digest,
    memberSessionHash: digest,
    drive: permit,
    cleanup: permit,
    stopRequested: z.boolean(),
    result: remoteResultDeclarationSchema.optional(),
    receipt: remoteResultReceiptSchema.optional(),
    inputs: z.array(remoteInputDescriptorSchema).max(REMOTE_RUN_LIMITS.inputs),
    lastWireEvent: z.strictObject({ sequence: positive, fingerprint: digest }).optional(),
    lastObservation: z.enum(['stop-received', 'retiring', 'unknown', 'drained']).optional(),
    controls: z
      .array(
        z.strictObject({
          requestId: z.uuid(),
          fingerprint: digest,
          operation: z.enum(['stop', 'renew']),
        }),
      )
      .max(4096),
  })
  .refine(
    (value) =>
      value.drive.id !== value.cleanup.id &&
      value.drive.sha256 !== value.cleanup.sha256 &&
      new Set(value.controls.map((control) => control.requestId)).size === value.controls.length,
  );
export type RemoteRunBinding = z.infer<typeof remoteRunBindingSchema>;
