export const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "xai",
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

const API_KEY_ENVIRONMENT_VARIABLES: Record<ModelProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
};

export function isModelProvider(value: unknown): value is ModelProvider {
  return MODEL_PROVIDERS.includes(value as ModelProvider);
}

export function modelApiKeyEnvironmentVariable(provider: ModelProvider) {
  return API_KEY_ENVIRONMENT_VARIABLES[provider];
}
