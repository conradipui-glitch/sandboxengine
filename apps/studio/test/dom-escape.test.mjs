import test from "node:test";
import assert from "node:assert/strict";
import { cssEscape, escapeAttr, escapeHtml } from "../dist/src/dom-escape.js";
import { shortHash, shortHashWide } from "../dist/src/short-hash.js";

test("escapeHtml escapes angle brackets", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml("a < b > c"), "a &lt; b &gt; c");
});

test("escapeHtml escapes ampersand and does not double-escape", () => {
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  // Одиночный проход: уже экранированные сущности превращаются в &amp;... один раз.
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  assert.equal(escapeHtml("&&"), "&amp;&amp;");
});

test("escapeHtml escapes double quotes and apostrophes", () => {
  assert.equal(escapeHtml('say "hi"'), "say &quot;hi&quot;");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml("'\"&<>"), "&#39;&quot;&amp;&lt;&gt;");
});

test("escapeHtml keeps empty string and plain text untouched", () => {
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml("обычный текст 123"), "обычный текст 123");
});

test("escapeHtml keeps unicode intact", () => {
  assert.equal(escapeHtml("Привет, мир! 你好 🎲"), "Привет, мир! 你好 🎲");
  assert.equal(escapeHtml("emoji 🎲 & <тег>"), "emoji 🎲 &amp; &lt;тег&gt;");
});

test("escapeAttr is an alias of escapeHtml", () => {
  assert.equal(escapeAttr('a"b<c>&d\'e'), "a&quot;b&lt;c&gt;&amp;d&#39;e");
  assert.equal(escapeAttr(""), "");
});

test("cssEscape escapes quotes and backslashes for attribute selectors", () => {
  assert.equal(cssEscape('a"b'), 'a\\"b');
  assert.equal(cssEscape("a\\b"), "a\\\\b");
  assert.equal(cssEscape("plain-id"), "plain-id");
  assert.equal(cssEscape(""), "");
});

test("shortHash keeps the 7/6 format and short values untouched", () => {
  assert.equal(shortHash("0123456789abcdef"), "0123456…abcdef");
  assert.equal(shortHash("0123456789abcd"), "0123456789abcd");
  assert.equal(shortHash(""), "");
});

test("shortHashWide keeps the 8/6 format and short values untouched", () => {
  assert.equal(shortHashWide("0123456789abcdef"), "01234567…abcdef");
  assert.equal(shortHashWide("0123456789abcd"), "0123456789abcd");
  assert.equal(shortHashWide(""), "");
});
