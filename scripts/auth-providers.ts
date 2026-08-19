type Environment = Record<string, string | undefined>;

const SUPPORTED_AUTH_PROVIDERS = new Set(["google"]);

/**
 * Which sign-in choices the static application should render.
 *
 * A frontend-only deployment cannot infer this from the API process's OAuth secrets. Give that
 * build a public list instead; it contains provider names only and never credentials. The fallback
 * preserves the all-in-one development build, where the generator and server share one environment.
 */
export function applicationAuthProviders(
  environment: Environment = process.env,
): string[] {
  const explicit = environment.VITE_OPENBOT_AUTH_PROVIDERS;
  if (explicit !== undefined) {
    const providers = [
      ...new Set(
        explicit
          .split(",")
          .map((provider) => provider.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];

    for (const provider of providers) {
      if (!SUPPORTED_AUTH_PROVIDERS.has(provider)) {
        throw new Error(
          `VITE_OPENBOT_AUTH_PROVIDERS contains an unsupported provider: ${provider}`,
        );
      }
    }

    return providers;
  }

  return environment.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
    environment.GOOGLE_OAUTH_CLIENT_SECRET?.trim() &&
    environment.BETTER_AUTH_SECRET?.trim() &&
    environment.BETTER_AUTH_URL?.trim()
    ? ["google"]
    : [];
}
