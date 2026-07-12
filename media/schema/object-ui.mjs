export function resolveSchemaSelection(objects, selection, fallbackName) {
  return objects.find((object) => (
    object.type === selection?.type && object.name === selection?.name
  )) ?? objects.find((object) => object.name === fallbackName) ?? null;
}

export function createSchemaSelection({ getTables, getObjects }) {
  let activeTableName = null;
  let selectedObject = null;

  function getActiveTable() {
    return getTables().find((table) => table.name === activeTableName) ?? null;
  }

  function getSelectedObject() {
    return getObjects().find((object) => (
      object.type === selectedObject?.type && object.name === selectedObject?.name
    )) ?? null;
  }

  function reconcile() {
    const tables = getTables();
    activeTableName = activeTableName && tables.some((table) => table.name === activeTableName)
      ? activeTableName
      : tables[0]?.name ?? null;
    selectedObject = resolveSchemaSelection(getObjects(), selectedObject, activeTableName);
  }

  function selectTable(tableName) {
    if (!tableName || !getTables().some((table) => table.name === tableName)) {
      return false;
    }
    activeTableName = tableName;
    selectedObject = getObjects().find((object) => object.name === tableName) ?? null;
    return true;
  }

  function selectObject(type, name) {
    const object = getObjects().find((candidate) => candidate.type === type && candidate.name === name);
    if (!object) {
      return false;
    }
    selectedObject = object;
    return true;
  }

  function set({ activeTableName: nextTableName = activeTableName, selectedObject: nextObject = selectedObject } = {}) {
    activeTableName = nextTableName;
    selectedObject = nextObject;
  }

  function clear() {
    activeTableName = null;
    selectedObject = null;
  }

  return {
    clear,
    reconcile,
    selectObject,
    selectTable,
    set,
    get activeTable() { return getActiveTable(); },
    get activeTableName() { return activeTableName; },
    get editableTable() {
      const table = getActiveTable();
      return table?.type === 'table' ? table : null;
    },
    get selectedObject() { return getSelectedObject(); },
  };
}

export function formatSchemaObjectDdl(object) {
  if (!object || !['index', 'trigger'].includes(object.type)) {
    return null;
  }
  return [
    `${object.type.toUpperCase()} ${object.name}`,
    '',
    object.sql || 'No CREATE statement available.',
    '',
    'Defined on',
    `- ${object.tableName}`,
  ].join('\n');
}

export function getObjectItemInteraction({ objectType, objectName, tableName }) {
  const browsable = objectType === 'table' || objectType === 'view';
  return browsable
    ? { browsable: true, selectable: true, title: undefined }
    : {
      browsable: false,
      selectable: objectType === 'index' || objectType === 'trigger',
      title: `Inspect ${objectName} DDL · defined on ${tableName}`,
    };
}
