interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

interface ConfigurationProvider {
  getConfiguration(section: string): ConfigurationReader;
}

export interface CopilotQueryOptions {
  maxResultRows: number;
  timeoutMs: number;
  sensitiveColumnPatterns: string[];
}

const DEFAULT_SENSITIVE_COLUMN_PATTERNS = [
  'password',
  'passwd',
  'token',
  'secret',
  'api[_-]?key',
  'ssn',
];

export function createCopilotConfigurationReaders(provider: ConfigurationProvider): {
  getCopilotEnabled(): boolean;
  getAccessMode(): 'ro' | 'rw';
  getQueryOptions(): CopilotQueryOptions;
} {
  const getConfiguration = () => provider.getConfiguration('databaseEditor.copilot');
  return {
    getCopilotEnabled: () => getConfiguration().get('enable', true),
    getAccessMode: () => getConfiguration().get<'ro' | 'rw'>('accessMode', 'ro'),
    getQueryOptions: () => {
      const configuration = getConfiguration();
      const sensitiveColumnPatterns = configuration.get<readonly string[]>(
        'sensitiveColumnPatterns',
        DEFAULT_SENSITIVE_COLUMN_PATTERNS,
      );
      return {
        maxResultRows: configuration.get('maxResultRows', 200),
        timeoutMs: configuration.get('queryTimeoutMs', 5_000),
        sensitiveColumnPatterns: [...sensitiveColumnPatterns],
      };
    },
  };
}
