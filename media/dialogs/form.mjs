import { runDialogMutation } from './workflows.mjs';
import { createElement } from '../utilities/dom.mjs';

let dialogCounter = 0;

export function showFormDialog({ documentRef = document, fallbackFocus, title, description, submitText, fields, onSubmit }) {
  const invoker = documentRef.activeElement;
  const dialogId = `schema-dialog-${++dialogCounter}`;
  const dialog = createElement('dialog', { className: 'insert-dialog schema-dialog', attributes: {
    'aria-labelledby': `${dialogId}-title`,
    'aria-describedby': description ? `${dialogId}-description` : undefined,
  } });
  const form = createElement('form', { attributes: { method: 'dialog' } });
  const fieldList = createElement('div', { className: 'insert-fields' });
  fieldList.append(...fields.map(createFormField));

  const cancel = createElement('button', { className: 'toolbar-button', text: 'Cancel', attributes: { type: 'button' } });
  const submit = createElement('button', { className: 'toolbar-button primary', text: submitText, attributes: { type: 'submit' } });
  const errorRegion = createElement('div', { className: 'validation-summary hidden', attributes: { role: 'alert' } });
  form.append(
    createElement('h2', { text: title, attributes: { id: `${dialogId}-title` } }),
    ...(description ? [createElement('pre', { className: 'csv-preview', text: description, attributes: { id: `${dialogId}-description` } })] : []),
    fieldList,
    errorRegion,
    createElement('div', { className: 'dialog-actions', children: [cancel, submit] }),
  );
  dialog.append(form);
  documentRef.body.append(dialog);

  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    (invoker?.isConnected ? invoker : fallbackFocus?.())?.focus?.();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await runDialogMutation({
      submitButton: submit,
      errorRegion,
      operation: () => onSubmit(readForm(form, fields)),
    });
    if (result.ok) dialog.close();
  });
  dialog.showModal();
  form.querySelector('input:not([type="checkbox"]), select, textarea')?.focus();
}

function createFormField(field) {
  let control;
  if (field.type === 'select') {
    control = createElement('select', { attributes: { name: field.name, required: field.required ? 'true' : undefined } });
    for (const option of field.options) {
      const value = typeof option === 'string' ? option : option.value;
      control.append(createElement('option', {
        text: typeof option === 'string' ? option : option.label,
        attributes: { value, selected: value === field.value ? 'selected' : undefined },
      }));
    }
    const first = field.options[0];
    control.value = field.value ?? String(typeof first === 'string' ? first : first?.value ?? '');
  } else {
    control = createElement('input', { attributes: {
      type: field.type === 'checkbox' ? 'checkbox' : 'text',
      name: field.name,
      value: field.value,
      checked: field.checked ? 'true' : undefined,
      required: field.required ? 'true' : undefined,
    } });
  }
  return createElement('label', { className: 'insert-field', children: [createElement('span', { text: field.label }), control] });
}

function readForm(form, fields) {
  return Object.fromEntries(fields.map((field) => {
    const control = form.elements.namedItem(field.name);
    return [field.name, field.type === 'checkbox' ? control.checked : control.value];
  }));
}
