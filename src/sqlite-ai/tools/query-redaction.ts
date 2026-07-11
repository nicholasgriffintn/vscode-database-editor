import type { SqlJsDatabase } from '../../sqljs-host';
import { getColumnsInfo, getSchemaObjects, getViewDefinition, type SchemaObjectType } from '../../sqlite-schema';

export function compileSensitivePatterns(patterns: string[]): RegExp[] {
  return patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern, 'i')];
    } catch {
      return [];
    }
  });
}

export function getColumns(db: SqlJsDatabase, sql: string): string[] {
  const statement = db.prepare(sql);
  try {
    return statement.getColumnNames();
  } finally {
    statement.free();
  }
}

type ExpressionSensitivity =
  | { kind: 'none' }
  | { kind: 'sensitive' }
  | { kind: 'ambiguous' }
  | { kind: 'wildcard'; redactedColumns: Set<string> | null };

type SelectClause = {
  selectList: string;
  fromClause: string;
};

export function inferRedactedOutputColumns(
  sql: string,
  columns: string[],
  sensitivePatterns: RegExp[],
  db?: SqlJsDatabase,
): Set<string> {
  const redactedColumns = new Set<string>();
  const statements = extractSelectClauses(sql);

  // Preserve prior behavior: for multi-statement SELECT chains, sensitive keyword presence should redact the entire result.
  const maskedSql = maskSqlCommentsAndStringLiterals(sql);
  if (statements.length > 1 && sensitivePatterns.some((pattern) => pattern.test(maskedSql))) {
    columns.forEach((column) => redactedColumns.add(column));
    return redactedColumns;
  }

  if (sensitivePatterns.length === 0) {
    for (const statement of statements) {
      const expressions = splitTopLevelComma(statement.selectList);
      expressions.forEach((expression, index) => {
        if (!expressionReferencesSensitiveColumn(expression, sensitivePatterns)) {
          return;
        }

        for (const outputName of getCandidateOutputNames(expression, index, columns)) {
          redactedColumns.add(outputName);
        }
      });
    }

    return redactedColumns;
  }

  // Existing behavior remains for non-db-based paths.
  if (!db) {
    statements.forEach((statement) => {
      const expressions = splitTopLevelComma(statement.selectList);
      expressions.forEach((expression, index) => {
        if (!expressionReferencesSensitiveColumn(expression, sensitivePatterns)) {
          return;
        }

        for (const outputName of getCandidateOutputNames(expression, index, columns)) {
          redactedColumns.add(outputName);
        }
      });
    });

    return redactedColumns;
  }

  const dbContext = createDatabaseRedactionContext(db, sensitivePatterns);

  for (const statement of statements) {
    const expressions = splitTopLevelComma(statement.selectList);
    const fromSources = parseFromSources(statement.fromClause);

    for (let index = 0; index < expressions.length; index += 1) {
      const expression = expressions[index];
      const sensitivity = inferExpressionSensitivity(expression, fromSources, dbContext, index);

      if (sensitivity.kind === 'none') {
        continue;
      }

      if (sensitivity.kind === 'wildcard') {
        const redacted = sensitivity.redactedColumns ?? null;
        if (redacted === null) {
          for (const column of columns) {
            redactedColumns.add(column);
          }
          continue;
        }

        for (const column of redacted) {
          redactedColumns.add(column);
        }

        continue;
      }

      for (const outputName of getCandidateOutputNames(expression, index, columns)) {
        if (sensitivity.kind === 'sensitive' || sensitivity.kind === 'ambiguous') {
          redactedColumns.add(outputName);
        }
      }
    }
  }

  return redactedColumns;
}

type DatabaseRedactionContext = {
  db: SqlJsDatabase;
  sensitivePatterns: RegExp[];
  schemaObjectTypeByName: Map<string, SchemaObjectType>;
  tableColumnSensitivityByName: Map<string, Map<string, boolean>>;
  viewOutputSensitivityByName: Map<string, Map<string, boolean> | null>;
  viewResolutionStack: Set<string>;
};

function createDatabaseRedactionContext(db: SqlJsDatabase, sensitivePatterns: RegExp[]): DatabaseRedactionContext {
  const schemaTypeByName = new Map<string, SchemaObjectType>();
  for (const object of getSchemaObjects(db)) {
    if (object.type === 'table' || object.type === 'view') {
      schemaTypeByName.set(object.name, object.type);
    }
  }

  return {
    db,
    sensitivePatterns,
    schemaObjectTypeByName: schemaTypeByName,
    tableColumnSensitivityByName: new Map(),
    viewOutputSensitivityByName: new Map(),
    viewResolutionStack: new Set(),
  };
}

function inferExpressionSensitivity(
  expression: string,
  fromSources: FromSource[],
  context: DatabaseRedactionContext,
  expressionIndex: number,
): ExpressionSensitivity {
  const maskedExpression = maskSqlCommentsAndStringLiterals(expression);

  const wildcardMatch = /^\s*(?:[A-Za-z0-9_$"\[`\s]+\.)?\*\s*(?:\s+AS\s+\S+)?$/i.test(maskedExpression);
  if (wildcardMatch) {
    const sourceAliasMatch = /^\s*([A-Za-z_$][\w$]*|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]])*\])\s*\.\*\b/i.exec(maskedExpression);
    if (sourceAliasMatch && sourceAliasMatch[1]) {
      const sourceAlias = normalizeIdentifier(sourceAliasMatch[1]);
      const source = fromSources.find((candidate) => candidate.alias === sourceAlias);
      if (!source) {
        return { kind: 'wildcard', redactedColumns: null };
      }
      const sensitiveColumns = getSourceSensitiveColumns(source, context);
      return { kind: 'wildcard', redactedColumns: sensitiveColumns ?? null };
    }

    if (!fromSources.length || fromSources.every((source) => isSubquerySource(source))) {
      return { kind: 'wildcard', redactedColumns: null };
    }

    if (fromSources.length === 1 && fromSources[0]) {
      const sensitiveColumns = getSourceSensitiveColumns(fromSources[0], context);
      return { kind: 'wildcard', redactedColumns: sensitiveColumns ?? null };
    }

    return { kind: 'wildcard', redactedColumns: null };
  }

  const references = extractColumnReferences(maskedExpression);
  if (references.length === 0) {
    return { kind: 'none' };
  }

  let isSensitive = false;
  let isAmbiguous = false;
  for (const reference of references) {
    const resolved = resolveReferenceSensitivity(reference, fromSources, context, expressionIndex);
    if (resolved === 'ambiguous') {
      isAmbiguous = true;
      break;
    }
    if (resolved) {
      isSensitive = true;
      break;
    }
  }

  if (isAmbiguous) {
    return { kind: 'ambiguous' };
  }

  return isSensitive ? { kind: 'sensitive' } : { kind: 'none' };
}

function resolveReferenceSensitivity(
  reference: ColumnReference,
  fromSources: FromSource[],
  context: DatabaseRedactionContext,
  expressionIndex: number,
): true | false | 'ambiguous' {
  if (reference.isStar) {
    return 'ambiguous';
  }

  if (reference.sourceAlias) {
    const source = fromSources.find((candidate) => candidate.alias === reference.sourceAlias);
    if (!source) {
      return 'ambiguous';
    }
    if (reference.columnName === null) {
      const columns = getSourceSensitiveColumns(source, context);
      return columns === null ? true : columns.size > 0;
    }
    return resolveColumnSensitivity(source, reference.columnName, context);
  }

  if (!reference.columnName) {
    // Expression-like references are not actionable for redaction if they do not refer to a column.
    return false;
  }

  const candidates: FromSource[] = [];
  for (const source of fromSources) {
    const sourceColumns = getSourceColumnNames(source, context);
    if (sourceColumns.includes(reference.columnName)) {
      candidates.push(source);
    }
  }

  if (candidates.length === 0) {
    // Unresolved references can indicate aliases or projections from CTEs;
    // treat as ambiguous lineage and fail closed.
    return 'ambiguous';
  }
  if (candidates.length > 1) {
    // Same column name in multiple sources is ambiguous.
    return 'ambiguous';
  }

  const source = candidates[0];
  if (!source) {
    return false;
  }

  return resolveColumnSensitivity(source, reference.columnName, context);
}

function resolveColumnSensitivity(source: FromSource, column: string, context: DatabaseRedactionContext): true | false | 'ambiguous' {
  const sourceColumns = getSourceColumnSensitivityMap(source, context);
  if (!sourceColumns) {
    return 'ambiguous';
  }

  const normalized = normalizeIdentifier(column);
  return sourceColumns.get(normalized) ?? false;
}

type ColumnReference = {
  sourceAlias?: string;
  columnName: string | null;
  isStar: boolean;
};

function extractColumnReferences(expression: string): ColumnReference[] {
  const projection = expression
    .replace(/\s+as\s+("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*$/i, '')
    .trim();
  if (!projection) {
    return [];
  }

  const result: ColumnReference[] = [];
  let index = 0;

  const reservedWords = new Set([
    'as',
    'on',
    'and',
    'or',
    'when',
    'then',
    'else',
    'from',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'full',
    'cross',
    'where',
    'group',
    'order',
    'limit',
    'union',
    'intersect',
    'except',
    'case',
    'end',
    'count',
    'sum',
    'avg',
    'min',
    'max',
    'coalesce',
    'nullif',
    'ifnull',
    'cast',
    'distinct',
    'select',
    'distinct',
    'null',
    'not',
    'in',
    'is',
    'like',
    'exists',
    'between',
  ]);

  while (index < projection.length) {
    const character = projection[index];

    if (character === '\'') {
      let cursor = index + 1;
      while (cursor < projection.length) {
        const next = projection[cursor];
        if (next === '\'') {
          if (projection[cursor + 1] === '\'') {
            cursor += 2;
            continue;
          }

          cursor += 1;
          break;
        }
        cursor += 1;
      }

      index = cursor;
      continue;
    }

    if (character === '"' || character === '`' || character === '[') {
      const token = readQuotedIdentifier(projection, index);
      if (token) {
        const first = { value: token.value, next: token.next };
        index = first.next;

        const firstNormalized = normalizeIdentifier(stripQuotes(first.value));
        if (reservedWords.has(firstNormalized)) {
          continue;
        }

        index = skipWhitespace(projection, index);
        let sourceAlias: string | undefined;
        let columnName: string | null = null;
        let isStar = false;

        if (projection[index] === '.') {
          index += 1;
          index = skipWhitespace(projection, index);
          if (projection[index] === '*') {
            isStar = true;
            index += 1;
          } else {
            const second = readIdentifierOrQuotedIdentifier(projection, index);
            if (second) {
              index = second.next;
              columnName = normalizeIdentifier(second.value);
            }
          }

          sourceAlias = firstNormalized;
        } else {
          columnName = firstNormalized;
        }

        if (sourceAlias && columnName === null && isStar) {
          result.push({ sourceAlias, columnName: null, isStar: true });
        } else if (sourceAlias && columnName) {
          result.push({ sourceAlias, columnName, isStar: false });
        } else if (columnName) {
          result.push({ columnName, isStar: false });
        }

        continue;
      }
    }

    if (/^[A-Za-z_$]$/.test(character)) {
      const first = readIdentifier(projection, index);
      if (first) {
        index = first.next;
        const firstNormalized = normalizeIdentifier(first.value);

        if (reservedWords.has(firstNormalized.toLowerCase())) {
          continue;
        }

        index = skipWhitespace(projection, index);

        if (projection[index] === '(') {
          // function call like lower(x) — do not treat "lower" as a sensitive column
          continue;
        }

        let sourceAlias: string | undefined;
        let columnName: string | null = null;
        let isStar = false;

        const secondChar = projection[index];
        if (secondChar === '.') {
          index += 1;
          index = skipWhitespace(projection, index);
          if (projection[index] === '*') {
            isStar = true;
            index += 1;
            columnName = null;
          } else {
            const second = readIdentifier(projection, index);
            if (second) {
              index = second.next;
              columnName = normalizeIdentifier(second.value);
            }
          }
          sourceAlias = firstNormalized;
        } else {
          columnName = firstNormalized;
        }

        if (sourceAlias && columnName === null && isStar) {
          result.push({ sourceAlias, columnName: null, isStar: true });
        } else if (sourceAlias && columnName) {
          result.push({ sourceAlias, columnName, isStar: false });
        } else if (columnName) {
          result.push({ columnName, isStar: false });
        }
      }
      continue;
    }

    if (character === '*') {
      result.push({ columnName: null, isStar: true });
    }

    index += 1;
  }

  return result;
}
function readIdentifier(sql: string, start: number): { value: string; next: number } | null {
  let index = start;
  while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) {
    index += 1;
  }

  if (index === start) {
    return null;
  }

  return { value: sql.slice(start, index), next: index };
}

function readIdentifierOrQuotedIdentifier(sql: string, start: number): { value: string; next: number } | null {
  const character = sql[start];
  if (character === '"' || character === '`' || character === '[') {
    const quoted = readQuotedIdentifier(sql, start);
    if (!quoted) {
      return null;
    }

    return quoted;
  }

  if (!/^[A-Za-z_$]/.test(character)) {
    return null;
  }

  return readIdentifier(sql, start);
}

function readQuotedIdentifier(sql: string, start: number): { value: string; next: number } | null {
  const quote = sql[start];
  if (quote !== '"' && quote !== '`' && quote !== '[') {
    return null;
  }

  const closeQuote = quote === '[' ? ']' : quote;
  let index = start + 1;

  while (index < sql.length) {
    const nextChar = sql[index];
    if (nextChar === closeQuote) {
      if (quote === '[' || sql[index + 1] !== closeQuote) {
        return { value: sql.slice(start, index + 1), next: index + 1 };
      }
      index += 1;
    }
    index += 1;
  }

  return { value: sql.slice(start), next: sql.length };
}

function skipWhitespace(text: string, index: number): number {
  while (text[index] && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
}

function normalizeIdentifier(value: string): string {
  let identifier = value.trim();
  if (!identifier) {
    return identifier;
  }

  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replace(/""/g, '"').toLowerCase();
  }
  if (identifier.startsWith('`') && identifier.endsWith('`')) {
    return identifier.slice(1, -1).replace(/``/g, '`').toLowerCase();
  }
  if (identifier.startsWith('[') && identifier.endsWith(']')) {
    return identifier.slice(1, -1).toLowerCase();
  }

  return identifier.toLowerCase();
}

type FromSource = {
  name: string;
  alias: string;
  type: SchemaObjectType | 'unknown' | 'subquery';
};

function parseFromSources(fromClause: string): FromSource[] {
  if (!fromClause.trim()) {
    return [];
  }

  const normalized = `from ${fromClause}`.replace(/,/g, ' join ');
  const sourcePattern = /\b(?:from|join)\s+((?:\[[^\]]+\]|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\([^)]*\)|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)?)(?:\s+(?:as\s+)?((?:\[[^\]]+\]|"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_$][\w$]*))?)?/gi;
  const sources: FromSource[] = [];
  const seenAliases = new Set<string>();

  const normalizedSources: Array<{ sourceToken: string; aliasToken?: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = sourcePattern.exec(normalized)) !== null) {
    const sourceToken = match[1];
    const aliasToken = match[2];
    if (!sourceToken) {
      continue;
    }
    normalizedSources.push({ sourceToken: sourceToken.trim(), aliasToken: aliasToken?.trim() });
  }

  if (!normalizedSources.length) {
    return [];
  }

  const knownTables = new Set(
    normalizedSources
      .map((entry) => {
        const sourceName = entry.sourceToken.trim();
        return sourceName;
      })
      .filter((sourceName) => sourceName && !sourceName.startsWith('(') && sourceName !== '?')
      .map((sourceName) => normalizeIdentifier(sourceName.split('.').at(-1) ?? sourceName)),
  );

  const allSchema = new Set<string>(knownTables);

  for (const entry of normalizedSources) {
    const rawSource = entry.sourceToken;
    if (rawSource.startsWith('(')) {
      const alias = entry.aliasToken ? normalizeIdentifier(stripQuotes(entry.aliasToken)) : `subquery_${sources.length + 1}`;
      const seenAlias = alias || `subquery_${sources.length + 1}`;
      if (!seenAliases.has(seenAlias)) {
        sources.push({ name: '', alias: seenAlias, type: 'subquery' });
        seenAliases.add(seenAlias);
      }
      continue;
    }

    const unquotedSource = stripQuotes(rawSource);
    const normalizedName = normalizeIdentifier(unquotedSource.split('.').at(-1) ?? unquotedSource);
    const alias = entry.aliasToken ? normalizeIdentifier(stripQuotes(entry.aliasToken)) : normalizedName;

    if (seenAliases.has(alias)) {
      continue;
    }
    seenAliases.add(alias);

    let sourceType: SchemaObjectType | 'unknown' | 'subquery' = 'unknown';
    if (allSchema.has(normalizedName)) {
      // Filled later via context cache.
    }

    sources.push({
      name: normalizedName,
      alias,
      type: sourceType,
    });
  }

  return sources;
}

function stripQuotes(identifier: string): string {
  if (!identifier) {
    return identifier;
  }
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replace(/""/g, '"');
  }
  if (identifier.startsWith('`') && identifier.endsWith('`')) {
    return identifier.slice(1, -1).replace(/``/g, '`');
  }
  if (identifier.startsWith('[') && identifier.endsWith(']')) {
    return identifier.slice(1, -1);
  }
  return identifier;
}

function isSubquerySource(source: FromSource): boolean {
  return source.type === 'subquery' || source.name === '';
}

function getSourceColumnNames(source: FromSource, context: DatabaseRedactionContext): string[] {
  return Array.from(getSourceColumnSensitivityMap(source, context)?.keys() ?? []);
}

function getSourceColumnSensitivityMap(source: FromSource, context: DatabaseRedactionContext): Map<string, boolean> | null {
  if (source.type === 'subquery') {
    return null;
  }

  const resolvedType = context.schemaObjectTypeByName.get(source.name);
  const actualType = source.type === 'unknown' ? resolvedType : source.type;

  if (!actualType) {
    return null;
  }

  if (actualType === 'table') {
    if (!context.tableColumnSensitivityByName.has(source.name)) {
      const sensitivity = new Map<string, boolean>();
      for (const row of getColumnsInfo(context.db, source.name) as { name?: unknown }[]) {
        const columnName = normalizeIdentifier(String(row.name ?? ''));
        if (!columnName) {
          continue;
        }
        sensitivity.set(columnName, isPatternMatch(columnName, context.sensitivePatterns));
      }
      context.tableColumnSensitivityByName.set(source.name, sensitivity);
    }

    return context.tableColumnSensitivityByName.get(source.name) ?? null;
  }

  if (actualType === 'view') {
    return getViewColumnSensitivity(source.name, context);
  }

  return null;
}

function getSourceSensitiveColumns(source: FromSource, context: DatabaseRedactionContext): Set<string> | null {
  const columnSensitivities = getSourceColumnSensitivityMap(source, context);
  if (!columnSensitivities) {
    return null;
  }

  return new Set(
    Array.from(columnSensitivities.entries())
      .filter(([_columnName, sensitive]) => sensitive)
      .map(([columnName]) => columnName),
  );
}

function getViewColumnSensitivity(viewName: string, context: DatabaseRedactionContext): Map<string, boolean> | null {
  if (context.viewOutputSensitivityByName.has(viewName)) {
    return context.viewOutputSensitivityByName.get(viewName) ?? null;
  }

  if (context.viewResolutionStack.has(viewName)) {
    context.viewOutputSensitivityByName.set(viewName, null);
    return null;
  }

  context.viewResolutionStack.add(viewName);
  try {
    const viewSql = getViewDefinition(context.db, viewName);
    if (!viewSql) {
      context.viewOutputSensitivityByName.set(viewName, null);
      return null;
    }

    const asIndex = findTopLevelKeyword(viewSql, 'as');
    if (asIndex < 0) {
      context.viewOutputSensitivityByName.set(viewName, null);
      return null;
    }

    const queryBody = viewSql.slice(asIndex + 2);
    const clauses = extractSelectClauses(queryBody);
    if (!clauses.length) {
      context.viewOutputSensitivityByName.set(viewName, null);
      return null;
    }

    const viewColumns = (getColumnsInfo(context.db, viewName) as { name?: unknown }[])
      .map((row) => normalizeIdentifier(String((row as { name?: unknown }).name ?? '')));
    const source = parseFromSources(clauses[0]?.fromClause ?? '');
    const outputSensitivity = new Map<string, boolean>();

    for (const clause of clauses) {
      const expressions = splitTopLevelComma(clause.selectList);
      for (let index = 0; index < expressions.length; index += 1) {
        const expression = expressions[index];
        const sensitivity = inferExpressionSensitivity(expression, source, context, index);
        const candidates = getCandidateOutputNames(expression, index, viewColumns);

        if (sensitivity.kind === 'wildcard') {
          if (sensitivity.redactedColumns === null) {
            for (const columnName of viewColumns) {
              outputSensitivity.set(columnName, true);
            }
          } else {
            for (const columnName of sensitivity.redactedColumns) {
              outputSensitivity.set(columnName, true);
            }
          }
          continue;
        }

        for (const candidate of candidates) {
          if (sensitivity.kind === 'sensitive' || sensitivity.kind === 'ambiguous') {
            outputSensitivity.set(candidate, true);
          } else if (!outputSensitivity.has(candidate)) {
            outputSensitivity.set(candidate, false);
          }
        }
      }
    }

    context.viewOutputSensitivityByName.set(viewName, outputSensitivity);
    return outputSensitivity;
  } finally {
    context.viewResolutionStack.delete(viewName);
  }
}

function isPatternMatch(identifier: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(identifier));
}

function getCandidateOutputNames(expression: string, expressionIndex: number, allColumns: string[]): string[] {
  const explicitAlias = getExplicitOutputName(expression);
  if (explicitAlias) {
    const normalizedAlias = normalizeIdentifier(explicitAlias);
    if (allColumns.includes(normalizedAlias)) {
      return [normalizedAlias];
    }
    if (allColumns.length > expressionIndex) {
      return [allColumns[expressionIndex], normalizedAlias];
    }
    return [normalizedAlias];
  }

  const trimmed = expression.trim();
  if (trimmed === '*' || /^\w+\.\*$/.test(trimmed)) {
    return [];
  }

  const simple = trimmed;
  if (simple && simple.includes(' ')) {
    const firstToken = simple.match(/^([^\s,()]+)(?:\s+(?:as|from|where|group|order|limit|join)|$)/i);
    if (firstToken?.[1]) {
      const outputName = stripAliasFromExpression(trimmed) || firstToken[1];
      const normalized = normalizeIdentifier(outputName);
      return normalized ? [normalized] : allColumns[expressionIndex] ? [allColumns[expressionIndex]] : [];
    }
  }

  if (allColumns.length > expressionIndex) {
    return [allColumns[expressionIndex]];
  }

  const explicit = getExplicitOutputName(expression);
  return explicit ? [normalizeIdentifier(explicit)] : [];
}

function stripAliasFromExpression(expression: string): string {
  const asIndex = expression.toLowerCase().lastIndexOf(' as ');
  if (asIndex !== -1) {
    return expression.slice(asIndex + 4).trim();
  }

  return expression.split(/\s+/)[0] ?? '';
}

function getExplicitOutputName(expression: string): string | undefined {
  const match = /\s+as\s+("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*$/i.exec(expression);
  if (!match) {
    return undefined;
  }

  const alias = match[1];
  if (!alias) {
    return undefined;
  }

  return stripQuotes(alias);
}

function extractSelectClauses(sql: string): SelectClause[] {
  const selectClauses: SelectClause[] = [];
  let selectIndex = findTopLevelKeyword(sql, 'select');

  while (selectIndex !== -1) {
    const listStart = selectIndex + 'select'.length;
    const nextCompoundIndex = Math.min(
      ...(['union', 'intersect', 'except'] as const)
        .map((keyword) => findTopLevelKeyword(sql, keyword, listStart))
        .filter((value) => value >= listStart),
      sql.length,
    );

    const listEnd = Math.min(
      ...(
        [
          findTopLevelKeyword(sql, 'from', listStart),
          findTopLevelKeyword(sql, 'where', listStart),
          findTopLevelKeyword(sql, 'group', listStart),
          findTopLevelKeyword(sql, 'order', listStart),
          findTopLevelKeyword(sql, 'limit', listStart),
          nextCompoundIndex,
          sql.length,
        ] as const
      ).filter((value) => value >= listStart),
      sql.length,
    );

    const selectList = sql.slice(listStart, listEnd).trim();

    const fromIndex = findTopLevelKeyword(sql, 'from', listStart);
    const fromEnd = Math.min(
      ...[
        findTopLevelKeyword(sql, 'where', listStart),
        findTopLevelKeyword(sql, 'group', listStart),
        findTopLevelKeyword(sql, 'order', listStart),
        findTopLevelKeyword(sql, 'limit', listStart),
        nextCompoundIndex,
        sql.length,
      ].filter((value) => value >= listStart),
      sql.length,
    );
    const fromClause = fromIndex === -1 || fromIndex > listEnd ? '' : sql.slice(fromIndex + 'from'.length, fromEnd).trim();

    if (selectList) {
      selectClauses.push({
        selectList,
        fromClause,
      });
    }

    if (nextCompoundIndex === -1) {
      break;
    }

    selectIndex = findTopLevelKeyword(sql, 'select', nextCompoundIndex + 1);
  }

  return selectClauses;
}

function findTopLevelKeyword(sql: string, keyword: string, startIndex = 0): number {
  let quote: string | undefined;
  let depth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (quote) {
      if (quote === ']' && character === ']') {
        quote = undefined;
      } else if (character === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character;
      continue;
    }

    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    if (character === '(') {
      depth += 1;
      continue;
    }

    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (index < startIndex || depth !== 0) {
      continue;
    }

    const candidate = sql.slice(index, index + keyword.length);
    const before = sql[index - 1];
    const after = sql[index + keyword.length];
    if (
      candidate.toLowerCase() === keyword
      && (!before || !/[\w$]/.test(before))
      && (!after || !/[\w$]/.test(after))
    ) {
      return index;
    }
  }

  return -1;
}

function splitTopLevelComma(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      current += character;
      if (character === quote) {
        if (value[index + 1] === quote) {
          current += value[index + 1];
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === '\'' || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character;
      current += character;
      continue;
    }

    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    }

    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function expressionReferencesSensitiveColumn(expression: string, sensitivePatterns: RegExp[]): boolean {
  const sourceExpression = expression
    .replace(/\s+as\s+[^\s]+$/i, '')
    .replace(/\s+[^\s]+$/i, '');
  return sensitivePatterns.some((pattern) => pattern.test(maskSqlCommentsAndStringLiterals(sourceExpression)));
}

function maskSqlCommentsAndStringLiterals(sql: string): string {
  return sql
    .replace(/--[^\n\r]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'([^']|'')*'/g, ' ');
}
