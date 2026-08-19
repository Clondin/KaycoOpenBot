import { createAuthClient } from "better-auth/react";
import { openbotApiOrigin } from "../api-origin";

export const authClient = createAuthClient(
  openbotApiOrigin ? { baseURL: openbotApiOrigin } : {},
);

export async function signInWithGoogle() {
  const result = await authClient.signIn.social({
    provider: "google" as never,
    callbackURL: window.location.origin,
  });

  if (result.error) {
    throw new Error(result.error.message ?? "Could not start Google sign-in.");
  }
}
