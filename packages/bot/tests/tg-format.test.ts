import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToTelegramHtml } from "../src/tg-format.ts";

test("bold, italic, strikethrough", () => {
  assert.equal(mdToTelegramHtml("**Healthy (6):**"), "<b>Healthy (6):</b>");
  assert.equal(mdToTelegramHtml("a *word* here"), "a <i>word</i> here");
  assert.equal(mdToTelegramHtml("~~gone~~"), "<s>gone</s>");
});

test("inline code and fences are preserved and escaped", () => {
  assert.equal(mdToTelegramHtml("the `oracle-pull` unit"), "the <code>oracle-pull</code> unit");
  assert.equal(mdToTelegramHtml("```\na < b && c\n```"), "<pre>a &lt; b &amp;&amp; c</pre>");
});

test("code is not reformatted by inline rules", () => {
  assert.equal(mdToTelegramHtml("`a*b*c`"), "<code>a*b*c</code>");
});

test("headings become bold, bullets become dots", () => {
  assert.equal(mdToTelegramHtml("### Down (2)"), "<b>Down (2)</b>");
  assert.equal(mdToTelegramHtml("- one\n- two"), "• one\n• two");
});

test("links render as anchors", () => {
  assert.equal(
    mdToTelegramHtml("[grafana](http://localhost:3000)"),
    '<a href="http://localhost:3000">grafana</a>'
  );
});

test("bare angle brackets and ampersands are escaped", () => {
  assert.equal(mdToTelegramHtml("dial-tcp 1<2 & up"), "dial-tcp 1&lt;2 &amp; up");
});

test("plain prose passes through unchanged", () => {
  assert.equal(mdToTelegramHtml("all good, you?"), "all good, you?");
});
