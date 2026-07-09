import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHistoryMessages,
  createSqliteChatParticipant,
  createSqliteFollowupProvider,
} from '../dist/sqlite-ai/chat-participant.js';

const ChatMessage = {
  User: (content) => ({ role: 'user', content }),
  Assistant: (content) => ({ role: 'assistant', content }),
};

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

test('chat history preserves recent user and assistant turns within its budget', () => {
  const history = [
    { prompt: 'first request' },
    { response: [{ value: { value: 'first response' } }] },
    { prompt: 'x'.repeat(13_000) },
  ];
  const messages = buildHistoryMessages(ChatMessage, history);

  assert.equal(messages.at(-1).role, 'user');
  assert.equal(messages.at(-1).content.length, 12_000);
  assert.equal(messages.some((message) => message.content === 'first request'), false);
});

test('participant grounds requests in selection context and provides native chat UX', async () => {
  let sentMessages;
  const invokedTools = [];
  const events = [];
  const vscode = {
    LanguageModelChatMessage: ChatMessage,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelChatToolMode: { Auto: 'auto', Required: 'required' },
    Uri: { parse: (value) => ({ value }) },
    lm: {
      tools: [{ name: 'databaseEditor_db_context' }, { name: 'unrelated' }],
      invokeTool: async (name, options) => {
        invokedTools.push({ name, options });
        return { content: [new LanguageModelTextPart('{"objects":[{"name":"people"}]}')] };
      },
    },
  };
  const handler = createSqliteChatParticipant({
    vscode,
    registry: {
      listOpenDatabases: () => [{ uri: 'file:///fixture.sqlite', name: 'fixture.sqlite', active: true }],
      getSelectionContext: () => ({
        databaseUri: 'file:///fixture.sqlite',
        objectName: 'people',
        objectType: 'table',
        filter: 'hunter2',
        columnFilters: { password: 'secret-token' },
      }),
    },
    getAccessMode: () => 'rw',
    getCopilotEnabled: () => true,
  });
  const result = await handler({
    prompt: 'show duplicates',
    command: 'schema',
    toolInvocationToken: 'chat-token',
    model: {
      callCount: 0,
      async sendRequest(messages, options) {
        sentMessages = { messages, options };
        this.callCount += 1;
        if (this.callCount === 1) {
          return {
            stream: (async function* () {
              yield new LanguageModelToolCallPart('call-1', 'databaseEditor_db_context', { databaseUri: 'file:///fixture.sqlite', objectName: 'people' });
            })(),
          };
        }
        return {
          stream: (async function* () { yield new LanguageModelTextPart('Grounded answer'); })(),
        };
      },
    },
  }, { history: [{ prompt: 'Earlier question' }] }, {
    progress: (value) => events.push(['progress', value]),
    reference: (value) => events.push(['reference', value]),
    markdown: (value) => events.push(['markdown', value]),
    button: (value) => events.push(['button', value]),
  }, { isCancellationRequested: false });

  assert.match(sentMessages.messages[0].content, /people/);
  assert.match(sentMessages.messages[0].content, /No row values or filter values are included/);
  assert.doesNotMatch(sentMessages.messages[0].content, /hunter2|secret-token/);
  assert.equal(sentMessages.messages.some((message) => message.content === 'Earlier question'), true);
  assert.deepEqual(sentMessages.options.tools.map((tool) => tool.name), ['databaseEditor_db_context']);
  assert.equal(invokedTools.length, 1);
  assert.deepEqual(invokedTools[0], {
    name: 'databaseEditor_db_context',
    options: {
      input: { databaseUri: 'file:///fixture.sqlite', objectName: 'people' },
      toolInvocationToken: 'chat-token',
    },
  });
  assert.equal(events.some(([type]) => type === 'progress'), true);
  assert.equal(events.some(([type]) => type === 'reference'), true);
  assert.equal(events.some(([type, value]) => type === 'markdown' && value === 'Grounded answer'), true);
  assert.equal(events.some(([type]) => type === 'button'), true);
  assert.equal(result.metadata.selectedObject, 'people');
});

test('participant narrows required initial tool requests to one tool', async () => {
  const sendOptions = [];
  const events = [];
  const vscode = {
    LanguageModelChatMessage: ChatMessage,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelChatToolMode: { Auto: 'auto', Required: 'required' },
    Uri: { parse: (value) => ({ value }) },
    lm: {
      tools: [
        { name: 'databaseEditor_db_context' },
        { name: 'databaseEditor_query' },
        { name: 'databaseEditor_profile' },
      ],
      invokeTool: async () => ({ content: [new LanguageModelTextPart('{"ok":true}')] }),
    },
  };
  const handler = createSqliteChatParticipant({
    vscode,
    registry: {
      listOpenDatabases: () => [{ uri: 'file:///fixture.sqlite', name: 'fixture.sqlite', active: true }],
      getSelectionContext: () => ({ databaseUri: 'file:///fixture.sqlite', objectName: 'people', objectType: 'table' }),
    },
    getAccessMode: () => 'ro',
    getCopilotEnabled: () => true,
  });

  await handler({
    prompt: 'show schema',
    command: 'schema',
    toolInvocationToken: 'chat-token',
    model: {
      callCount: 0,
      async sendRequest(_messages, options) {
        sendOptions.push(options);
        if (options.toolMode === 'required' && options.tools.length > 1) {
          throw new Error('LanguageModelChatToolMode.Required is not supported with more than one tool');
        }
        this.callCount += 1;
        if (this.callCount === 1) {
          return {
            stream: (async function* () {
              yield new LanguageModelToolCallPart('call-1', 'databaseEditor_db_context', { databaseUri: 'file:///fixture.sqlite' });
            })(),
          };
        }
        return {
          stream: (async function* () { yield new LanguageModelTextPart('Schema summary'); })(),
        };
      },
    },
  }, { history: [] }, {
    progress: (value) => events.push(['progress', value]),
    reference: (value) => events.push(['reference', value]),
    markdown: (value) => events.push(['markdown', value]),
    button: (value) => events.push(['button', value]),
  }, { isCancellationRequested: false });

  assert.equal(sendOptions[0].toolMode, 'required');
  assert.deepEqual(sendOptions[0].tools.map((tool) => tool.name), ['databaseEditor_db_context']);
  assert.equal(sendOptions[1].toolMode, 'auto');
  assert.deepEqual(sendOptions[1].tools.map((tool) => tool.name), [
    'databaseEditor_db_context',
    'databaseEditor_query',
    'databaseEditor_profile',
  ]);
  assert.equal(events.some(([type, value]) => type === 'markdown' && value === 'Schema summary'), true);
});

test('follow-ups offer schema, profile, and query-plan workflows', async () => {
  const followups = await createSqliteFollowupProvider().provideFollowups({ metadata: { selectedObject: 'people' } });
  assert.deepEqual(followups.map((followup) => followup.command), ['schema', 'profile', 'explain']);
  assert.match(followups[0].prompt, /people/);
});
