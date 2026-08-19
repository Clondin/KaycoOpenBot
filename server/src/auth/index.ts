import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  sessions,
  userRoles,
  users,
  verifications,
} from "../db/schema";
import { roleForEmail } from "./roles";

export function createAuth(config: DeploymentConfig, database: Database) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("Google authentication is not configured.");
  }

  return betterAuth({
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    socialProviders: {
      google: authConfig.google,
    },
    onAPIError: {
      // OAuth errors belong on the application sign-in screen, not at the API server's root.
      errorURL: new URL("/sign", authConfig.trustedOrigins[0]).toString(),
    },
    ...(authConfig.crossSiteCookies
      ? {
          advanced: {
            useSecureCookies: true,
            defaultCookieAttributes: {
              httpOnly: true,
              secure: true,
              sameSite: "none" as const,
            },
          },
        }
      : {}),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await database
              .insert(userRoles)
              .values({
                userId: user.id,
                role: roleForEmail(user.email, authConfig.initialAdminEmails),
              })
              .onConflictDoNothing();
          },
        },
      },
    },
  });
}
