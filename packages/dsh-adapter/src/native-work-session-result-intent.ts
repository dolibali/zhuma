import { z } from 'zod';
import { nativeResultIntentSchema } from './native-work-session-result-contract.js';
import { nativeResultPublicationsIntentSchema } from './native-work-session-result-publications-contract.js';

/** Absent and v1 metadata retain their exact shape; v2 is explicit and discriminated. */
export const nativeWorkResultIntentSchema = z.discriminatedUnion('protocolVersion', [
  nativeResultIntentSchema,
  nativeResultPublicationsIntentSchema,
]);
export type NativeWorkResultIntent = z.infer<typeof nativeWorkResultIntentSchema>;
