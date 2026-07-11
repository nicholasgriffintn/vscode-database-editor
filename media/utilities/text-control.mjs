export function isTextControl(target) {
  const tag = String(target?.tagName ?? '').toLowerCase();
  return (tag === 'input' || tag === 'textarea') && typeof target.value === 'string';
}

export function replaceTextControlSelection(target, text, options = {}) {
  if (!isTextControl(target) || target.readOnly || target.disabled) {
    return;
  }
  const documentRef = options.documentRef ?? document;
  const createInputEvent = options.createInputEvent ?? (() => new Event('input', { bubbles: true }));
  if (documentRef.activeElement === target && documentRef.execCommand('insertText', false, text)) {
    target.dispatchEvent(createInputEvent());
    return;
  }

  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  if (typeof target.setRangeText === 'function') {
    target.setRangeText(text, start, end, 'end');
  } else {
    target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
    const nextCursor = start + text.length;
    target.setSelectionRange?.(nextCursor, nextCursor);
  }
  target.dispatchEvent(createInputEvent());
}

export function deleteTextControlSelection(target, options = {}) {
  if (!isTextControl(target) || target.readOnly || target.disabled) {
    return;
  }
  const documentRef = options.documentRef ?? document;
  const createInputEvent = options.createInputEvent ?? (() => new Event('input', { bubbles: true }));
  if (documentRef.activeElement === target && documentRef.execCommand('delete')) {
    target.dispatchEvent(createInputEvent());
    return;
  }
  replaceTextControlSelection(target, '', { documentRef, createInputEvent });
}

export function getSelectedTextInControl(target) {
  if (!isTextControl(target)) {
    return '';
  }
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? start;
  return target.value.slice(start, end);
}

export async function applyTextEditingShortcut(target, action, options) {
  if (!isTextControl(target)) {
    return;
  }
  const {
    writeClipboardText,
    readClipboardText,
    documentRef,
    createInputEvent,
  } = options;
  switch (action) {
    case 'selectAll':
      target.select?.();
      break;
    case 'copy':
      await writeClipboardText(getSelectedTextInControl(target));
      break;
    case 'cut':
      await writeClipboardText(getSelectedTextInControl(target));
      deleteTextControlSelection(target, { documentRef, createInputEvent });
      break;
    case 'paste':
      replaceTextControlSelection(target, await readClipboardText(), { documentRef, createInputEvent });
      break;
  }
}
