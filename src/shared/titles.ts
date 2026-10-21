// OMP's terminal cards use <icon> <CODE>: <name>. Desktop displays the name.
const TERMINAL_CARD_TITLE = /^[\p{Co}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D]+\s+[A-Z][A-Z0-9_-]*:\s+(\S.*)$/u;

export function displaySessionTitle(title: string): string {
  return TERMINAL_CARD_TITLE.exec(title)?.[1] ?? title;
}
