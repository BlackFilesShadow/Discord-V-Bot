import { MAX_TRANSLATED_POST_IMAGE_BYTES } from '../../src/modules/ai/translatedPostImage';

describe('translated post image upload limit', () => {
  test('matches Discord default per-attachment limit of 10 MiB', () => {
    expect(MAX_TRANSLATED_POST_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});
