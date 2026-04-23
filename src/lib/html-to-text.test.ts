import { describe, it, expect } from 'vitest';
import { htmlToText } from './html-to-text.js';

describe('htmlToText', () => {
  it('returns empty for null/undefined/empty', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('strips a plain paragraph', () => {
    expect(htmlToText('<p>Hello world</p>')).toBe('Hello world');
  });

  it('preserves word boundaries between block-level elements', () => {
    expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello World');
    expect(htmlToText('<li>one</li><li>two</li>')).toBe('one two');
  });

  it('strips inline tags without introducing spaces', () => {
    expect(htmlToText('<p>It was <em>really</em> good.</p>')).toBe(
      'It was really good.'
    );
  });

  it('removes script, style, and noscript blocks with contents', () => {
    const input =
      '<p>Before</p><script>alert(1)</script><style>p{color:red}</style><noscript>fallback</noscript><p>After</p>';
    expect(htmlToText(input)).toBe('Before After');
  });

  it('removes HTML comments', () => {
    expect(htmlToText('<p>Hello<!-- TODO --> world</p>')).toBe('Hello world');
  });

  it('decodes common HTML entities', () => {
    expect(htmlToText('<p>AT&amp;T said &quot;hi&quot;</p>')).toBe(
      'AT&T said "hi"'
    );
    expect(htmlToText('<p>&nbsp;spaces&nbsp;</p>')).toBe('spaces');
    expect(htmlToText('<p>&ldquo;Quote&rdquo; &mdash; author</p>')).toBe(
      '“Quote” — author'
    );
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>&#8212;&#x2014;</p>')).toBe('——');
  });

  it('collapses whitespace runs into a single space', () => {
    expect(htmlToText('<p>Hello   \n\n   world</p>')).toBe('Hello world');
  });

  it('truncates at the nearest word boundary under maxChars', () => {
    const input = '<p>The quick brown fox jumps over the lazy dog</p>';
    expect(htmlToText(input, { maxChars: 15 })).toBe('The quick brown');
    expect(htmlToText(input, { maxChars: 19 })).toBe('The quick brown fox');
  });

  it('does not truncate when input is shorter than maxChars', () => {
    expect(htmlToText('<p>Short</p>', { maxChars: 100 })).toBe('Short');
  });

  it('handles the NYT-style article body shape', () => {
    const input =
      '<article><h1>Headline</h1><p>A documentary about the writer <strong>Jim Downey</strong> is streaming.</p><p>He worked on S.N.L.</p></article>';
    expect(htmlToText(input)).toBe(
      'Headline A documentary about the writer Jim Downey is streaming. He worked on S.N.L.'
    );
  });
});
