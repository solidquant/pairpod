// Convert Claude's CommonMark to the small HTML subset Telegram renders. Telegram has no
// headings/lists/tables, so headings become bold lines and bullets become "• ". Code spans
// and fences are pulled out first so their contents aren't mangled by the inline rules.
const NUL = String.fromCharCode(0);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mdToTelegramHtml(md: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => `${NUL}${stash.push(html) - 1}${NUL}`;

  let s = md.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    keep(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`)
  );
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));

  s = escapeHtml(s);

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>").replace(/__([^\n_]+)__/g, "<b>$1</b>");
  s = s.replace(/~~([^\n~]+)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w])_([^\n_]+)_(?![_\w])/g, "$1<i>$2</i>");
  s = s.replace(/^#{1,6}\s+(.*)$/gm, "<b>$1</b>");
  s = s.replace(/^(\s*)[-*+]\s+/gm, "$1• ");

  const re = new RegExp(`${NUL}(\\d+)${NUL}`, "g");
  return s.replace(re, (_m, i: string) => stash[Number(i)] ?? "");
}
