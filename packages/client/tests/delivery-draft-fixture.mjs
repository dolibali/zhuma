// Public response replay only; not stored files or authenticated draft state.
export const savedDraft = () => ({
  version: 7,
  text: '订单交付草稿',
  links: ['https://example.test/orders', 'https://example.test/errors'],
  files: [
    {
      id: 'contract.md',
      mediaType: 'text/markdown',
      byteSize: 42,
      checksum: 'fixture-checksum',
      accessPolicyId: 'fixture-policy',
      uploadComplete: false,
    },
  ],
});
