import { formatRowCount } from '../database/metadata.mjs';
import { createElement, createSvgElement, clear } from '../utilities/dom.mjs';
import {
  buildSchemaGraphModel,
  getSchemaGraphEdgePath,
  getSchemaGraphEmptyState,
  layoutSchemaGraph,
} from './graph.mjs';
import { formatSchemaObjectDdl, getObjectItemInteraction } from './object-ui.mjs';

export function createSchemaView({ elements, getState, activateSchemaView }) {
  function renderSidebar() {
    const { tables, schemaObjects, selectedSchemaObject, objectFilter } = getState();
    const previousScrollTop = elements.sidebar.scrollTop;
    clear(elements.sidebar);
    const search = createElement('input', { className: 'object-search', attributes: {
      type: 'search', placeholder: 'Search objects', value: objectFilter, 'data-object-search': 'true',
      'aria-label': 'Search schema objects',
    } });
    elements.sidebar.append(createElement('div', { className: 'object-search-wrap', children: [search, elements.objectRefresh] }));
    appendSection('Tables', tables.filter((table) => table.type === 'table'), selectedSchemaObject, objectFilter);
    appendSection('Views', tables.filter((table) => table.type === 'view'), selectedSchemaObject, objectFilter);
    appendSection('Indexes', schemaObjects.filter((object) => object.type === 'index'), selectedSchemaObject, objectFilter);
    appendSection('Triggers', schemaObjects.filter((object) => object.type === 'trigger'), selectedSchemaObject, objectFilter);
    elements.sidebar.scrollTop = previousScrollTop;
  }

  function appendSection(label, objects, selection, filter) {
    const normalized = filter.trim().toLowerCase();
    const visible = objects.filter((object) => !normalized || [object.name, object.type, object.tableName]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(normalized)));
    if (visible.length === 0) return;
    elements.sidebar.append(createElement('div', { className: 'sidebar-heading', text: label }));
    for (const object of visible) {
      const interaction = getObjectItemInteraction({ objectType: object.type, objectName: object.name, tableName: object.tableName });
      const selected = object.type === selection?.type && object.name === selection?.name;
      const attributes = interaction.browsable
        ? { type: 'button', 'data-table': object.name }
        : interaction.selectable ? { type: 'button', 'data-schema-object': object.name, 'data-schema-object-type': object.type } : {};
      elements.sidebar.append(createElement(interaction.selectable ? 'button' : 'div', {
        className: [selected ? 'object-item active' : 'object-item', interaction.browsable ? '' : 'secondary'].filter(Boolean).join(' '),
        title: interaction.title,
        attributes,
        children: [
          createElement('span', { className: 'object-name', text: object.name }),
          createElement('span', { className: 'object-meta', text: interaction.browsable
            ? formatRowCount(object.rowCount, { loading: object.type === 'table' && object.rowCount === null })
            : object.tableName }),
        ],
      }));
    }
  }

  function focusObjectSearch() {
    const { objectFilter } = getState();
    const search = elements.sidebar.querySelector('[data-object-search]');
    search?.focus();
    search?.setSelectionRange?.(objectFilter.length, objectFilter.length);
  }

  function renderSchema() {
    const state = getState();
    const object = state.selectedSchemaObject;
    elements.dropIndex.disabled = object?.type !== 'index';
    elements.createIndex.disabled = !state.tables.some((table) => table.type === 'table');
    if (object && (object.type === 'index' || object.type === 'trigger')) {
      elements.schema.textContent = formatSchemaObjectDdl(object);
    } else if (!state.activeTable) {
      elements.schema.textContent = 'No schema available.';
    } else {
      elements.schema.textContent = formatTableDdl(state.activeTable);
    }
    renderGraph();
    activateSchemaView(state.activeSchemaView);
  }

  function renderGraph() {
    const { tables, activeTableName } = getState();
    const emptyState = getSchemaGraphEmptyState(tables);
    const model = layoutSchemaGraph(buildSchemaGraphModel(tables));
    const relationships = `${model.edges.length.toLocaleString()} ${model.edges.length === 1 ? 'relationship' : 'relationships'}`;
    elements.schemaGraphSummary.textContent = tables.length === 0 ? 'No tables' : `${tables.length.toLocaleString()} ${tables.length === 1 ? 'object' : 'objects'} · ${relationships}`;
    elements.schemaGraphFit.disabled = tables.length === 0;
    elements.schemaGraphLayout.disabled = tables.length === 0;
    if (emptyState?.kind === 'no-tables') {
      elements.schemaGraph.replaceChildren(buildEmptyState(emptyState));
      return;
    }
    const svg = createSvgElement('svg', { className: 'schema-graph', attributes: {
      role: 'img', 'aria-label': 'SQLite schema relationship graph', viewBox: `0 0 ${model.bounds.width} ${model.bounds.height}`,
      width: String(model.bounds.width), height: String(model.bounds.height),
    } });
    svg.append(buildDefs());
    const nodes = new Map(model.nodes.map((node) => [node.id, node]));
    const edgeLayer = createSvgElement('g', { className: 'schema-graph-edges' });
    for (const edge of model.edges) {
      const sourceNode = nodes.get(edge.sourceTable);
      const targetNode = nodes.get(edge.targetTable);
      if (!sourceNode || !targetNode) continue;
      const path = createSvgElement('path', { className: 'schema-graph-edge', attributes: {
        d: getSchemaGraphEdgePath({ edge, sourceNode, targetNode }), 'marker-end': 'url(#schema-graph-arrow)',
      } });
      path.append(createSvgElement('title', { text: edgeTitle(edge) }));
      edgeLayer.append(path);
    }
    svg.append(edgeLayer);
    const nodeLayer = createSvgElement('g', { className: 'schema-graph-nodes' });
    for (const node of model.nodes) nodeLayer.append(renderNode(node, activeTableName));
    svg.append(nodeLayer);
    const children = [];
    if (emptyState?.kind === 'no-relationships') children.push(buildEmptyState(emptyState, true));
    if (model.skippedEdgeCount > 0) children.push(createElement('div', { className: 'schema-graph-note', text:
      `${model.skippedEdgeCount.toLocaleString()} foreign-key ${model.skippedEdgeCount === 1 ? 'edge points' : 'edges point'} to missing tables and ${model.skippedEdgeCount === 1 ? 'was' : 'were'} hidden.` }));
    elements.schemaGraph.replaceChildren(...children, svg);
  }

  function fitGraph() {
    elements.schemaGraph.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  }

  return { fitGraph, focusObjectSearch, renderGraph, renderSchema, renderSidebar };
}

function formatTableDdl(table) {
  const columns = table.columns.map((column) => [
    `- ${column.name}`, column.type ? `type ${column.type}` : 'type ANY', column.nullable ? 'nullable' : 'not null',
    column.primaryKeyOrder ? `primary key ${column.primaryKeyOrder}` : null,
    column.defaultValue == null ? null : `default ${column.defaultValue}`,
  ].filter(Boolean).join(' · '));
  const foreignKeys = table.foreignKeys.map((key) => `- ${key.from} -> ${key.table}.${key.to || 'rowid'} on update ${key.on_update ?? 'NO ACTION'} on delete ${key.on_delete ?? 'NO ACTION'}`);
  const indexes = table.indexes.map((index) => `- ${index.name}\n${index.sql}`);
  const triggers = table.triggers.map((trigger) => `- ${trigger.name}\n${trigger.sql}`);
  return [
    `${table.type.toUpperCase()} ${table.name}`, '', table.sql || 'No CREATE statement available.', '',
    'Columns', columns.join('\n') || '- none', '', 'Foreign keys', foreignKeys.join('\n') || '- none', '',
    'Indexes', indexes.join('\n\n') || '- none', '', 'Triggers', triggers.join('\n\n') || '- none',
  ].join('\n');
}

function buildEmptyState(state, compact = false) {
  return createElement('div', { className: compact ? 'schema-graph-empty compact' : 'schema-graph-empty', children: [
    createElement('div', { className: 'schema-graph-empty-title', text: state.title }),
    createElement('div', { className: 'schema-graph-empty-description', text: state.description }),
  ] });
}

function buildDefs() {
  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker', { className: 'schema-graph-arrow-marker', attributes: {
    id: 'schema-graph-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
  } });
  marker.append(createSvgElement('path', { attributes: { d: 'M 0 0 L 10 5 L 0 10 z' } }));
  defs.append(marker);
  return defs;
}

function renderNode(node, activeTableName) {
  const group = createSvgElement('g', { className: [
    'schema-graph-node', node.tableType === 'view' ? 'view-node' : 'table-node', node.tableName === activeTableName ? 'active' : '',
  ].filter(Boolean).join(' '), attributes: {
    transform: `translate(${node.x} ${node.y})`, tabindex: '0', role: 'button',
    'data-schema-graph-table': node.tableName, 'aria-label': `${node.tableType} ${node.tableName}`,
  } });
  group.append(createSvgElement('title', { text: `${node.tableType} ${node.tableName} · ${formatRowCount(node.rowCount)}` }));
  group.append(createSvgElement('rect', { className: 'schema-graph-card', attributes: { width: String(node.width), height: String(node.height), rx: '10', ry: '10' } }));
  group.append(createSvgElement('rect', { className: 'schema-graph-card-header', attributes: { width: String(node.width), height: '34', rx: '10', ry: '10' } }));
  group.append(createSvgElement('text', { className: 'schema-graph-table-name', text: node.tableName, attributes: { x: '12', y: '22' } }));
  group.append(createSvgElement('text', { className: 'schema-graph-table-meta', text: node.tableType === 'view' ? 'VIEW' : formatRowCount(node.rowCount), attributes: { x: String(node.width - 12), y: '22', 'text-anchor': 'end' } }));
  node.columns.forEach((column, index) => group.append(renderColumn(node, column, index)));
  return group;
}

function renderColumn(node, column, index) {
  const y = 34 + (index * 24);
  const row = createSvgElement('g', { className: 'schema-graph-column-row' });
  row.append(createSvgElement('rect', { attributes: { x: '0', y: String(y), width: String(node.width), height: '24' } }));
  if (column.foreignKey) row.append(createSvgElement('circle', { className: 'schema-graph-handle source', attributes: { cx: String(node.width), cy: String(y + 12), r: '3.5' } }));
  row.append(createSvgElement('circle', { className: 'schema-graph-handle target', attributes: { cx: '0', cy: String(y + 12), r: '3' } }));
  row.append(createSvgElement('text', { className: 'schema-graph-column-name', text: column.name, attributes: { x: '12', y: String(y + 16) } }));
  const badges = [column.primaryKey ? 'PK' : null, column.foreignKey ? 'FK' : null, !column.nullable ? 'NN' : null].filter(Boolean);
  row.append(createSvgElement('text', { className: `schema-graph-column-type${column.primaryKey ? ' pk' : ''}${column.foreignKey ? ' fk' : ''}`,
    text: [badges.join(' '), column.type || 'ANY'].filter(Boolean).join(' · '), attributes: { x: String(node.width - 12), y: String(y + 16), 'text-anchor': 'end' } }));
  row.append(createSvgElement('title', { text: [column.name, column.type || 'ANY', column.primaryKey ? 'primary key' : null, column.foreignKey ? 'foreign key' : null, column.nullable ? 'nullable' : 'not null'].filter(Boolean).join(' · ') }));
  return row;
}

function edgeTitle(edge) {
  return [`${edge.sourceTable}.${edge.sourceColumn} → ${edge.targetTable}.${edge.targetColumn}`, edge.onUpdate ? `ON UPDATE ${edge.onUpdate}` : null, edge.onDelete ? `ON DELETE ${edge.onDelete}` : null].filter(Boolean).join(' · ');
}
