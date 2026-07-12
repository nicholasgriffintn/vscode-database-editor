export function normalizeRowFieldValue({ inputValue, nullChecked }) {
  return nullChecked ? null : inputValue;
}

export function rowValuesEqual(previousValue, nextValue) {
  if (previousValue === null || previousValue === undefined || nextValue === null || nextValue === undefined) {
    return previousValue === nextValue;
  }

  return String(previousValue) === String(nextValue);
}

export function getRowFieldState({ previousValue, nextValue, readOnly }) {
  const dirty = !readOnly && !rowValuesEqual(previousValue, nextValue);
  return {
    dirty,
    resetDisabled: !dirty,
  };
}

export function getRowValidationErrors(fields) {
  return fields
    .filter(({ column, value, readOnly }) => !readOnly && value === null && column.nullable === false)
    .map(({ column }) => `${column.name} cannot be NULL.`);
}
