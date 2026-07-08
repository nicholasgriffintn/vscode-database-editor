import type * as vscode from 'vscode';

import type { SqliteToolRegistry } from './tools';
import { SQLITE_TOOL_NAMES } from './tools';

type VscodeChatApi = Pick<typeof vscode,
  | 'LanguageModelChatMessage'
  | 'LanguageModelChatToolMode'
  | 'LanguageModelTextPart'
  | 'LanguageModelToolCallPart'
  | 'LanguageModelToolResultPart'
  | 'lm'
  | 'workspace'
>;

type CreateSqliteChatParticipantOptions = {
  vscode: VscodeChatApi;
  registry: Pick<SqliteToolRegistry, 'listOpenDatabases'>;
  getAccessMode(): 'ro' | 'rw';
};

const MAX_TOOL_ROUNDS = 8;

export function createSqliteChatParticipant({
  vscode,
  registry,
  getAccessMode,
}: CreateSqliteChatParticipantOptions): vscode.ChatRequestHandler {
  return async (request, _context, response, token) => {
    if (!vscode.workspace.getConfiguration('databaseEditor.copilot').get('enable', true)) {
      response.markdown('Copilot integration is disabled by `databaseEditor.copilot.enable`.');
      return;
    }

    if (registry.listOpenDatabases().length === 0) {
      response.markdown('Open a SQLite database with SQLite Database Editor first.');
      return;
    }

    const messages = [
      vscode.LanguageModelChatMessage.User(buildSystemPrompt(getAccessMode())),
      vscode.LanguageModelChatMessage.User(request.prompt),
    ];
    const tools = getAvailableTools(vscode, getAccessMode());

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const modelResponse = await request.model.sendRequest(messages, {
        justification: 'Use SQLite Database Editor Copilot tools to answer questions about open databases.',
        tools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      }, token);
      const responseParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];

      for await (const part of modelResponse.stream) {
        if (part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart) {
          responseParts.push(part);
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }

      if (toolCalls.length === 0) {
        const text = responseParts
          .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
          .map((part) => part.value)
          .join('');
        response.markdown(text || 'No response was returned.');
        return;
      }

      messages.push(vscode.LanguageModelChatMessage.Assistant(responseParts));
      for (const toolCall of toolCalls) {
        const toolResult = await vscode.lm.invokeTool(toolCall.name, {
          input: toolCall.input,
          toolInvocationToken: request.toolInvocationToken,
        }, token);
        messages.push(vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(toolCall.callId, toolResult.content),
        ]));
      }
    }

    response.markdown('I stopped after several tool calls. Try narrowing the request.');
  };
}

function getAvailableTools(vscode: VscodeChatApi, accessMode: 'ro' | 'rw'): vscode.LanguageModelChatTool[] {
  const toolNames = new Set<string>(
    accessMode === 'rw'
      ? SQLITE_TOOL_NAMES
      : SQLITE_TOOL_NAMES.filter((name) => name !== 'databaseEditor_modify'),
  );

  return vscode.lm.tools
    .filter((tool) => toolNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}

function buildSystemPrompt(accessMode: 'ro' | 'rw'): string {
  return [
    'You are helping with an open SQLite database in VS Code.',
    'Use tools whenever database facts are needed; do not invent schema, tables, columns, or query results.',
    'Use databaseEditor_db_context before writing SQL against unknown tables.',
    'Use databaseEditor_query for read-only inspection.',
    accessMode === 'rw'
      ? 'Only use databaseEditor_modify when the user explicitly asks for a database change; explain the change before the tool call.'
      : 'Do not modify the database; read/write Copilot tools are disabled.',
    'Return concise answers with SQL in fenced code blocks when useful.',
  ].join('\n');
}
