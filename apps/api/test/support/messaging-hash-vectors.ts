// Fixed cross-runtime SHA-256 vectors. The null/empty case tests canonicalization only.
export const messagingHashVectors = [
  {
    name: 'open',
    envelope: {
      operation: 'open',
      intent: {
        clientRequestId: '77777777-7777-4777-8777-777777777777',
        entry: {
          kind: 'reply',
          postId: '55555555-5555-4555-8555-555555555555',
          rootCommentId: '88888888-8888-4888-8888-888888888888',
          replyId: '66666666-6666-4666-8666-666666666666',
        },
        initiationMode: 'anonymous',
      },
    },
    canonical:
      '{"intent":{"clientRequestId":"77777777-7777-4777-8777-777777777777","entry":{"kind":"reply","postId":"55555555-5555-4555-8555-555555555555","replyId":"66666666-6666-4666-8666-666666666666","rootCommentId":"88888888-8888-4888-8888-888888888888"},"initiationMode":"anonymous"},"operation":"open"}',
    hash: 'f0ef234caae9cafe21ebc63226b80820e7637275e3ab804a8e7fb864280bf226',
  },
  {
    name: 'send',
    envelope: {
      operation: 'send',
      intent: {
        clientRequestId: '77777777-7777-4777-8777-777777777777',
        conversationId: '55555555-5555-4555-8555-555555555555',
        text: '鲸鱼😀\n第二行\t"quoted"\\',
      },
    },
    canonical:
      '{"intent":{"clientRequestId":"77777777-7777-4777-8777-777777777777","conversationId":"55555555-5555-4555-8555-555555555555","text":"鲸鱼😀\\n第二行\\t\\"quoted\\"\\\\"},"operation":"send"}',
    hash: '72411ecade10ff8eda265ef7e4773fb06ea8b8da058d5059ccf70f1817856cb3',
  },
  {
    name: 'read',
    envelope: {
      operation: 'read',
      intent: {
        clientRequestId: '77777777-7777-4777-8777-777777777777',
        conversationId: '55555555-5555-4555-8555-555555555555',
        observationId: '88888888-8888-4888-8888-888888888888',
      },
    },
    canonical:
      '{"intent":{"clientRequestId":"77777777-7777-4777-8777-777777777777","conversationId":"55555555-5555-4555-8555-555555555555","observationId":"88888888-8888-4888-8888-888888888888"},"operation":"read"}',
    hash: '4f75aef6af08d25cac931dd05efe2fb363a77b2740be673d0df130d6b9bb4e9d',
  },
  {
    name: 'hide',
    envelope: {
      operation: 'hide',
      intent: {
        clientRequestId: '77777777-7777-4777-8777-777777777777',
        conversationId: '55555555-5555-4555-8555-555555555555',
      },
    },
    canonical:
      '{"intent":{"clientRequestId":"77777777-7777-4777-8777-777777777777","conversationId":"55555555-5555-4555-8555-555555555555"},"operation":"hide"}',
    hash: '71f071a9adb8545afad5b163a96c8116ccab81971ab201763e9b2ad119455c6e',
  },
  {
    name: 'reopen',
    envelope: {
      operation: 'reopen',
      intent: {
        clientRequestId: '77777777-7777-4777-8777-777777777777',
        conversationId: '55555555-5555-4555-8555-555555555555',
      },
    },
    canonical:
      '{"intent":{"clientRequestId":"77777777-7777-4777-8777-777777777777","conversationId":"55555555-5555-4555-8555-555555555555"},"operation":"reopen"}',
    hash: '18f8df67d46334cc265728928b9310669ac72b87581f3ecbcf5860b6dca623e7',
  },
  {
    name: 'recall',
    envelope: {
      operation: 'recall',
      intent: {
        clientRequestId: '77777777-7777-4777-8777-777777777777',
        conversationId: '55555555-5555-4555-8555-555555555555',
        messageId: '66666666-6666-4666-8666-666666666666',
      },
    },
    canonical:
      '{"intent":{"clientRequestId":"77777777-7777-4777-8777-777777777777","conversationId":"55555555-5555-4555-8555-555555555555","messageId":"66666666-6666-4666-8666-666666666666"},"operation":"recall"}',
    hash: '85f10ca986ab8e231ee077bcf5baa9f237e1cab36fc9c221df468b8ebd9f1d09',
  },
  {
    name: 'block',
    envelope: {
      operation: 'block',
      intent: {
        clientRequestId: '77777777-7777-4777-8777-777777777777',
        conversationId: '55555555-5555-4555-8555-555555555555',
      },
    },
    canonical:
      '{"intent":{"clientRequestId":"77777777-7777-4777-8777-777777777777","conversationId":"55555555-5555-4555-8555-555555555555"},"operation":"block"}',
    hash: '4af7af97cfd88e81c45e9bb9ccb7494ad7bf6c344dbdbe1281d0fb1bf4b696f8',
  },
  {
    name: 'canonical-null-empty-not-a-command',
    envelope: {
      intent: {
        nullValue: null,
        emptyString: '',
        emptyArray: [],
        nested: {
          z: false,
          a: '  ',
        },
      },
      operation: 'canonical_fixture_only',
    },
    canonical:
      '{"intent":{"emptyArray":[],"emptyString":"","nested":{"a":"  ","z":false},"nullValue":null},"operation":"canonical_fixture_only"}',
    hash: 'ce197ab4c853b00b75cfc60678488fb55a133067c065b903478fc256fcb5ae11',
  },
] as const;
