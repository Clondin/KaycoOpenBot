import { createAuthClient } from "better-auth/react";
import { apiUrl, openbotApiOrigin } from "../api-origin";

export const authClient = createAuthClient(
  openbotApiOrigin ? { baseURL: openbotApiOrigin } : {},
);

export function googleSignInUrl(callbackOrigin: string): string {
  const query = new URLSearchParams({ callbackURL: callbackOrigin });
  return apiUrl(`/api/auth/google/start?${query.toString()}`);
}

export async function signInWithGoogle() {
  window.location.assign(googleSignInUrl(window.location.origin));
}
