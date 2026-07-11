export function formatSqlCodeBlock(sql: string): string {
  const trimmed = sql.trim();
  const longestBacktickRun = Math.max(0, ...trimmed.match(/`+/g)?.map((match) => match.length) ?? []);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}sql\n${trimmed}\n${fence}`;
}

export function escapeMarkdown(value: string): string {
  return String(value).replace(/[\\`*_{}\[\]()#+\-!|>]/g, '\\$&');
}
