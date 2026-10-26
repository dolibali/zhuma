/** Binding validator retained from 54d162d356eec1549239a92b7597b7e880313bf6.
 * The shared scope/selection schemas are unchanged by the result protocol. */
import { z } from 'zod';
import { nativeScopeSchema, nativeSelectionSchema } from '../dist/native-work-session-record.js';
const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const legacyNativeBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: nativeScopeSchema,
  nativeSessionId: id,
  nativeAgentId: id,
  selection: nativeSelectionSchema,
  receipts: z
    .array(
      z.strictObject({
        requestId: id,
        messageId: id,
        fingerprint: digest,
        mode: z.enum(['followup', 'steer', 'queue']),
        status: z.enum(['reserved', 'received', 'claimed', 'discarded', 'unknown']),
      }),
    )
    .max(256),
  inputReadBudget: z
    .strictObject({
      attempts: z.number().int().min(0).max(16),
      chargedBytes: z.number().int().min(0).max(65536),
    })
    .optional(),
});
