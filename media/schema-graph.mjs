const DEFAULT_LAYOUT = Object.freeze({
  nodeWidth: 260,
  headerHeight: 34,
  rowHeight: 24,
  minNodeHeight: 80,
  rankGap: 120,
  nodeGapY: 28,
  padding: 24,
});

export function buildSchemaGraphModel(tables = []) {
  const tableList = Array.isArray(tables) ? tables : [];
  const tableNames = new Set(tableList.map((table) => table.name));
  const nodes = tableList.map((table) => buildNode(table));
  const edges = [];
  let skippedEdgeCount = 0;

  for (const table of tableList) {
    for (const key of table.foreignKeys ?? []) {
      const targetTable = String(key.table ?? '').trim();
      if (!targetTable || !tableNames.has(targetTable)) {
        skippedEdgeCount += 1;
        continue;
      }

      const sourceColumn = String(key.from ?? '').trim() || 'rowid';
      const targetColumn = String(key.to ?? '').trim() || 'rowid';
      edges.push({
        id: `${table.name}.${key.id ?? 'fk'}:${key.seq ?? 0}:${sourceColumn}->${targetTable}.${targetColumn}`,
        sourceTable: table.name,
        sourceColumn,
        targetTable,
        targetColumn,
        onUpdate: key.on_update ?? key.onUpdate ?? undefined,
        onDelete: key.on_delete ?? key.onDelete ?? undefined,
      });
    }
  }

  return { nodes, edges, skippedEdgeCount };
}

function buildNode(table) {
  const columns = (table.columns ?? []).map((column) => ({
    name: column.name,
    type: column.type || 'ANY',
    primaryKey: Number(column.primaryKeyOrder ?? 0) > 0,
    foreignKey: Boolean(column.foreignKeyTarget || column.keyKind === 'FK'),
    nullable: Boolean(column.nullable),
  }));

  const height = Math.max(
    DEFAULT_LAYOUT.minNodeHeight,
    DEFAULT_LAYOUT.headerHeight + (columns.length * DEFAULT_LAYOUT.rowHeight),
  );

  return {
    id: table.name,
    tableName: table.name,
    tableType: table.type ?? 'table',
    rowCount: Number.isFinite(Number(table.rowCount)) ? Number(table.rowCount) : 0,
    columns,
    width: DEFAULT_LAYOUT.nodeWidth,
    height,
    x: 0,
    y: 0,
  };
}

export function layoutSchemaGraph(model, options = {}) {
  const layout = { ...DEFAULT_LAYOUT, ...options };
  const sourceNodes = Array.isArray(model?.nodes) ? model.nodes : [];
  const sourceEdges = Array.isArray(model?.edges) ? model.edges : [];
  const ranks = rankNodes(sourceNodes, sourceEdges);
  const grouped = new Map();

  for (const node of sourceNodes) {
    const rank = ranks.get(node.id) ?? 0;
    if (!grouped.has(rank)) {
      grouped.set(rank, []);
    }
    grouped.get(rank).push(node);
  }

  const sortedRanks = [...grouped.keys()].sort((a, b) => a - b);
  const laidOutNodes = [];
  let maxRight = layout.padding;
  let maxBottom = layout.padding;

  for (const rank of sortedRanks) {
    const rankNodesList = grouped.get(rank).slice().sort((a, b) => a.tableName.localeCompare(b.tableName));
    let y = layout.padding;
    const x = layout.padding + (rank * (layout.nodeWidth + layout.rankGap));

    for (const node of rankNodesList) {
      const columns = node.columns.map((column) => ({ ...column }));
      const height = Math.max(layout.minNodeHeight, layout.headerHeight + (columns.length * layout.rowHeight));
      const nextNode = {
        ...node,
        columns,
        width: layout.nodeWidth,
        height,
        x,
        y,
      };
      laidOutNodes.push(nextNode);
      y += height + layout.nodeGapY;
      maxRight = Math.max(maxRight, x + layout.nodeWidth + layout.padding);
      maxBottom = Math.max(maxBottom, nextNode.y + height + layout.padding);
    }
  }

  return {
    nodes: laidOutNodes,
    edges: sourceEdges.map((edge) => ({ ...edge })),
    skippedEdgeCount: model?.skippedEdgeCount ?? 0,
    bounds: {
      width: Math.max(maxRight, layout.nodeWidth + (layout.padding * 2)),
      height: Math.max(maxBottom, layout.minNodeHeight + (layout.padding * 2)),
    },
  };
}

function rankNodes(nodes, edges) {
  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  const nodeIds = new Set(ranks.keys());
  const usableEdges = edges.filter((edge) => (
    nodeIds.has(edge.sourceTable)
    && nodeIds.has(edge.targetTable)
    && edge.sourceTable !== edge.targetTable
  ));

  const maxIterations = Math.max(1, nodes.length * nodes.length);
  for (let i = 0; i < maxIterations; i += 1) {
    let changed = false;
    for (const edge of usableEdges) {
      const targetRank = ranks.get(edge.targetTable) ?? 0;
      const sourceRank = ranks.get(edge.sourceTable) ?? 0;
      const nextSourceRank = Math.max(sourceRank, targetRank + 1);
      if (nextSourceRank !== sourceRank && nextSourceRank <= nodes.length) {
        ranks.set(edge.sourceTable, nextSourceRank);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  for (const [id, rank] of ranks) {
    if (!Number.isFinite(rank) || rank < 0 || rank > nodes.length) {
      ranks.set(id, 0);
    }
  }

  return ranks;
}

export function getSchemaGraphEmptyState(tables = []) {
  const tableList = Array.isArray(tables) ? tables : [];
  if (tableList.length === 0) {
    return {
      kind: 'no-tables',
      title: 'No tables found',
      description: 'Create a table to start visualizing this database schema.',
    };
  }

  const tableNames = new Set(tableList.map((table) => table.name));
  const hasVisibleRelationship = tableList.some((table) => (
    (table.foreignKeys ?? []).some((key) => tableNames.has(key.table))
  ));

  if (!hasVisibleRelationship) {
    return {
      kind: 'no-relationships',
      title: 'No foreign-key relationships found',
      description: 'Standalone tables are still shown so the schema stays browsable.',
    };
  }

  return null;
}

export function getSchemaGraphColumnY(node, columnName, options = {}) {
  const layout = { ...DEFAULT_LAYOUT, ...options };
  const columnIndex = node.columns.findIndex((column) => column.name === columnName);
  const safeIndex = columnIndex === -1 ? 0 : columnIndex;
  return node.y + layout.headerHeight + (safeIndex * layout.rowHeight) + (layout.rowHeight / 2);
}

export function getSchemaGraphEdgePath({ edge, sourceNode, targetNode, options = {} }) {
  const layout = { ...DEFAULT_LAYOUT, ...options };
  const sourceY = getSchemaGraphColumnY(sourceNode, edge.sourceColumn, layout);
  const targetY = getSchemaGraphColumnY(targetNode, edge.targetColumn, layout);
  const sourceX = sourceNode.x + sourceNode.width;
  const targetX = targetNode.x;

  if (sourceNode.id === targetNode.id) {
    const loopRight = sourceNode.x + sourceNode.width + 58;
    const topY = Math.max(sourceNode.y + 12, sourceY - 38);
    const bottomY = Math.min(sourceNode.y + sourceNode.height - 12, sourceY + 38);
    return `M ${sourceX} ${sourceY} C ${loopRight} ${sourceY}, ${loopRight} ${topY}, ${sourceX - 8} ${topY} L ${sourceX - 8} ${bottomY} C ${loopRight} ${bottomY}, ${loopRight} ${targetY}, ${sourceX} ${targetY}`;
  }

  const curve = Math.max(60, Math.abs(targetX - sourceX) / 2);
  return `M ${sourceX} ${sourceY} C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`;
}
