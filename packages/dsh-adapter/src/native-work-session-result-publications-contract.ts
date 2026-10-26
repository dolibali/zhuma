import { z } from 'zod';
import { WorkTaskSchema, validateDeliveryContent } from '@zhuma/agent-core';
import { NATIVE_RESULT_LIMITS } from './native-work-session-result-contract.js';

export const NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION = 'zhuma-native-result-intent@2';
export const NATIVE_RESULT_PUBLICATIONS_LIMIT = 20;

/** Model selectors only. A selector never authenticates a receipt or its bytes. */
export const nativeResultPublicationsContentSchema = z
  .strictObject({
    text: z.string().max(NATIVE_RESULT_LIMITS.textCharacters).optional(),
    links: z.array(z.string()).max(NATIVE_RESULT_LIMITS.links),
    publications: z
      .array(z.strictObject({ publicationId: WorkTaskSchema.shape.id }))
      .max(NATIVE_RESULT_PUBLICATIONS_LIMIT),
  })
  .superRefine((value, ctx) => {
    if (
      value.links.some((link) => !validateDeliveryContent({ links: [link], files: [] }).ok) ||
      (!value.publications.length &&
        !validateDeliveryContent({
          ...(value.text === undefined ? {} : { text: value.text }),
          links: value.links,
          files: [],
        }).ok)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Nonempty content and safe HTTP(S) links required.',
      });
    if (
      new Set(value.publications.map((item) => item.publicationId)).size !==
      value.publications.length
    )
      ctx.addIssue({ code: 'custom', message: 'Publication selectors must be unique.' });
  })
  .transform((value) => ({
    ...(value.text === undefined ? {} : { text: value.text.trim() }),
    links: Object.freeze(value.links.map((link) => link.trim())),
    publications: Object.freeze(value.publications.map((item) => Object.freeze({ ...item }))),
  }));
export type NativeResultPublicationsContent = z.infer<typeof nativeResultPublicationsContentSchema>;
