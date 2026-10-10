export function manifestFixture() {
  const object = (key: string) => ({
    provider: 'local-fixture',
    environment: 'synthetic',
    bucket: 'synthetic',
    key,
    version: '00000000-0000-4000-8000-000000000004',
  });
  return {
    version: 1,
    policyVersion: 'media-static-v1',
    transformVersion: 'static-reencode-v1',
    original: {
      object: object('00000000-0000-4000-8000-000000000001'),
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      bytes: 500,
      width: 800,
      height: 600,
    },
    variants: [
      {
        name: 'thumb-v1',
        object: object('00000000-0000-4000-8000-000000000002'),
        sha256: 'b'.repeat(64),
        mime: 'image/png',
        bytes: 100,
        width: 400,
        height: 300,
      },
      {
        name: 'display-v1',
        object: object('00000000-0000-4000-8000-000000000003'),
        sha256: 'c'.repeat(64),
        mime: 'image/png',
        bytes: 400,
        width: 800,
        height: 600,
      },
    ],
  };
}
