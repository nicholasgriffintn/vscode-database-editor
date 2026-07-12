export function getSaveButtonState({ hasDatabase, isDirty, isSaving }) {
  return {
    disabled: !hasDatabase || isSaving || !isDirty,
    label: isSaving ? 'Saving…' : 'Save',
  };
}

export function getDirtyStatusText({ hasDatabase, isDirty, isSaving }) {
  if (!hasDatabase) {
    return 'Waiting for file';
  }
  if (isSaving) {
    return 'Saving…';
  }
  return isDirty ? 'Unsaved changes' : 'All changes saved';
}
