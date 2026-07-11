import { getErrorMessage } from './utilities/errors.mjs';

export function createConfirmationModel({
  kind,
  tableName,
  columnName,
  rowNumber,
  count,
  target,
  action = 'delete',
} = {}) {
  const table = tableName ? `“${tableName}”` : 'the current table';
  switch (kind) {
    case 'row':
      return {
        title: 'Delete row',
        message: `Delete row ${rowNumber} from ${table}? This cannot be undone until you use VS Code Undo.`,
        confirmLabel: 'Delete row',
        destructive: true,
      };
    case 'rows': {
      const rowCount = Math.max(0, Number(count) || 0);
      return {
        title: 'Delete selected rows',
        message: `Delete ${rowCount.toLocaleString()} selected ${rowCount === 1 ? 'row' : 'rows'} from ${table}? This cannot be undone until you use VS Code Undo.`,
        confirmLabel: rowCount === 1 ? 'Delete row' : `Delete ${rowCount.toLocaleString()} rows`,
        destructive: true,
      };
    }
    case 'cell':
      return {
        title: 'Clear cell',
        message: `Set ${table}.${columnName} in row ${rowNumber} to NULL? This cannot be undone until you use VS Code Undo.`,
        confirmLabel: 'Clear cell',
        destructive: true,
      };
    case 'column':
      return {
        title: 'Drop column',
        message: `Drop column ${table}.${columnName}? This cannot be undone after saving.`,
        confirmLabel: 'Drop column',
        destructive: true,
      };
    case 'table':
      return {
        title: 'Drop table',
        message: `Drop table ${table}? This cannot be undone after saving.`,
        confirmLabel: 'Drop table',
        destructive: true,
      };
    case 'sql':
      return {
        title: 'Run destructive SQL',
        message: `Run this ${action} statement against ${target || 'the identified SQL target'}? Review it carefully; the change cannot be undone after saving.`,
        confirmLabel: 'Run SQL',
        destructive: true,
      };
    default:
      throw new Error(`Unknown confirmation kind: ${kind}`);
  }
}

export function createDiscardDraftModel({ tableName, rowNumber, destination = 'closing this dialog' } = {}) {
  return {
    title: 'Discard unsaved edits?',
    message: `Discard edits to row ${rowNumber} in “${tableName}” before ${destination}?`,
    confirmLabel: 'Discard edits',
    destructive: true,
  };
}

export function getDestructiveSqlConfirmationDetails(analysis) {
  for (const statement of analysis?.statements ?? []) {
    const trimmed = statement.trim();
    const deleteMatch = trimmed.match(/^delete\s+from\s+([^\s;]+)/i);
    if (deleteMatch) {
      return { action: 'DELETE', target: deleteMatch[1] };
    }
    const dropMatch = trimmed.match(/^drop\s+(table|view|index|trigger)\s+(?:if\s+exists\s+)?([^\s;]+)/i);
    if (dropMatch) {
      return { action: `DROP ${dropMatch[1].toUpperCase()}`, target: dropMatch[2] };
    }
    const alterMatch = trimmed.match(/^alter\s+table\s+([^\s;]+)[\s\S]*\bdrop\s+(?:column\s+)?([^\s;]+)/i);
    if (alterMatch) {
      return { action: 'DROP COLUMN', target: `${alterMatch[1]}.${alterMatch[2]}` };
    }
  }
  return null;
}

export function requiresDestructiveSqlConfirmation(analysis) {
  return (analysis?.statements ?? []).some((statement) => (
    /^\s*(?:delete|drop)\b/i.test(statement)
    || /^\s*alter\s+table\b[\s\S]*\bdrop\b/i.test(statement)
  ));
}

export async function runDialogMutation({ submitButton, errorRegion, operation }) {
  if (submitButton?.dataset?.pending === 'true') {
    return { ok: false, pending: true };
  }

  if (submitButton) {
    submitButton.dataset.pending = 'true';
    submitButton.disabled = true;
    submitButton.setAttribute?.('aria-busy', 'true');
  }
  renderDialogError(errorRegion, '');

  try {
    const result = await operation();
    if (result?.ok === false) {
      const error = getErrorMessage(result.error);
      renderDialogError(errorRegion, error);
      return { ok: false, error };
    }
    return { ok: true, value: result };
  } catch (error) {
    const message = getErrorMessage(error);
    renderDialogError(errorRegion, message);
    return { ok: false, error: message };
  } finally {
    if (submitButton) {
      delete submitButton.dataset.pending;
      submitButton.disabled = false;
      submitButton.removeAttribute?.('aria-busy');
    }
  }
}

export function showConfirmation({ model, invoker, documentRef = document, fallbackFocus } = {}) {
  return new Promise((resolve) => {
    const dialog = documentRef.createElement('dialog');
    dialog.className = 'insert-dialog confirm-dialog';
    const form = documentRef.createElement('form');
    form.setAttribute('method', 'dialog');
    const title = documentRef.createElement('h2');
    title.textContent = model.title;
    const message = documentRef.createElement('p');
    message.className = 'confirm-message';
    message.textContent = model.message;
    const actions = documentRef.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = documentRef.createElement('button');
    cancel.type = 'button';
    cancel.className = 'toolbar-button';
    cancel.textContent = 'Cancel';
    const confirm = documentRef.createElement('button');
    confirm.type = 'button';
    confirm.className = model.destructive ? 'toolbar-button danger' : 'toolbar-button primary';
    confirm.textContent = model.confirmLabel;
    actions.append(cancel, confirm);
    form.append(title, message, actions);
    dialog.append(form);
    documentRef.body.append(dialog);

    let settled = false;
    const restoreFocus = () => {
      const target = invoker?.isConnected ? invoker : fallbackFocus?.();
      target?.focus?.();
    };
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      dialog.close();
    };

    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
      dialog.remove();
      restoreFocus();
    });
    dialog.showModal();
    cancel.focus();
  });
}

function renderDialogError(region, message) {
  if (!region) {
    return;
  }
  region.textContent = message;
  region.classList?.toggle?.('hidden', !message);
}
