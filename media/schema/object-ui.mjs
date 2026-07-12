export function resolveSchemaSelection(objects, selection, fallbackName) {
  return objects.find((object) => (
    object.type === selection?.type && object.name === selection?.name
  )) ?? objects.find((object) => object.name === fallbackName) ?? null;
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
