import {
  safeEmbedField,
  safeEmbedTitle,
  safeEmbedDescription,
  safeEmbedFooter,
  safeEmbedAuthor,
  stripMassMentions,
} from '../../src/utils/embedSanitize';

describe('embedSanitize', () => {
  describe('safeEmbedField', () => {
    it('returns ZWS for null/undefined/empty', () => {
      expect(safeEmbedField(null)).toBe('\u200B');
      expect(safeEmbedField(undefined)).toBe('\u200B');
      expect(safeEmbedField('')).toBe('\u200B');
    });

    it('escapes Markdown special chars', () => {
      const out = safeEmbedField('**bold** _italic_ `code` ~~strike~~');
      expect(out).not.toContain('**');
      expect(out).toContain('\\*\\*bold\\*\\*');
    });

    it('coerces non-string input', () => {
      expect(safeEmbedField(42)).toBe('42');
      expect(safeEmbedField(true)).toBe('true');
    });

    it('truncates with ... when exceeding maxLength', () => {
      const long = 'a'.repeat(2000);
      const out = safeEmbedField(long, 1024);
      expect(out.length).toBeLessThanOrEqual(1024);
      expect(out.endsWith('...')).toBe(true);
    });

    it('does not truncate when within limit', () => {
      const out = safeEmbedField('short text');
      expect(out).toBe('short text');
    });

    it('respects custom maxLength', () => {
      const out = safeEmbedField('abcdefghij', 5);
      expect(out.length).toBeLessThanOrEqual(5);
      expect(out.endsWith('...')).toBe(true);
    });
  });

  describe('preset wrappers', () => {
    it('safeEmbedTitle caps at 256', () => {
      const out = safeEmbedTitle('x'.repeat(500));
      expect(out.length).toBeLessThanOrEqual(256);
    });

    it('safeEmbedDescription caps at 4096', () => {
      const out = safeEmbedDescription('y'.repeat(5000));
      expect(out.length).toBeLessThanOrEqual(4096);
    });

    it('safeEmbedFooter caps at 2048', () => {
      const out = safeEmbedFooter('z'.repeat(3000));
      expect(out.length).toBeLessThanOrEqual(2048);
    });

    it('safeEmbedAuthor caps at 256', () => {
      const out = safeEmbedAuthor('w'.repeat(500));
      expect(out.length).toBeLessThanOrEqual(256);
    });
  });

  describe('stripMassMentions', () => {
    it('neutralises @everyone', () => {
      const out = stripMassMentions('hello @everyone test');
      expect(out).toBe('hello @\u200Beveryone test');
      expect(out).not.toMatch(/@everyone(?!\u200B)/);
    });

    it('neutralises @here case-insensitive', () => {
      expect(stripMassMentions('@HERE')).toBe('@\u200BHERE');
    });

    it('does not affect normal mentions', () => {
      expect(stripMassMentions('<@123456789>')).toBe('<@123456789>');
    });
  });
});
