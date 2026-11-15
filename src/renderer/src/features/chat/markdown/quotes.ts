/** Called only for markdown text tokens, never HTML attributes, code or link destinations.
 * Same six delimiter pairs as ST; retain the delimiters and their exact text.
 */
export function wrapQuotes(text: string): string {
  return text.replace(/(&quot;.*?&quot;|".*?"|“.*?”|«.*?»|「.*?」|『.*?』|＂.*?＂)/g, '<q>$1</q>')
}
