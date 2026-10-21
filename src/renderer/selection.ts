export interface TextSelection { anchor: number; focus: number }

/** Offsets preserve a selection across edits to the selected text container only. */
export function captureTextSelection(root: HTMLElement): TextSelection | null {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const anchor = document.createRange(); anchor.selectNodeContents(root); anchor.setEnd(selection.anchorNode, selection.anchorOffset);
  const focus = document.createRange(); focus.selectNodeContents(root); focus.setEnd(selection.focusNode, selection.focusOffset);
  return { anchor: anchor.toString().length, focus: focus.toString().length };
}
export function restoreTextSelection(root: HTMLElement, saved: TextSelection | null): void {
  if (!saved) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remainingAnchor = saved.anchor; let remainingFocus = saved.focus;
  let anchor: { node: Text; offset: number } | null = null;
  let focus: { node: Text; offset: number } | null = null;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    last = node;
    if (!anchor) { if (remainingAnchor <= node.length) anchor = { node, offset: remainingAnchor }; else remainingAnchor -= node.length; }
    if (!focus) { if (remainingFocus <= node.length) focus = { node, offset: remainingFocus }; else remainingFocus -= node.length; }
    if (anchor && focus) break;
  }
  if (!last) return;
  anchor ??= { node: last, offset: last.length }; focus ??= { node: last, offset: last.length };
  window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}
