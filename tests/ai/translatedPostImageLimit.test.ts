import { MAX_TRANSLATED_POST_IMAGE_BYTES } from '../../src/modules/ai/translatedPostImage';

describe('translated post image upload limit', () => {
  test('keeps a positive MiB-sized upload ceiling', () => {
    expect(MAX_TRANSLATED_POST_IMAGE_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  });
});
