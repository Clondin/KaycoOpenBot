import { expect, test } from "bun:test";
import {
  authClient,
  googleSignInUrl,
  signInWithGoogle,
} from "@/lib/auth/client";

test("starts the Google social sign-in flow through the Better Auth client", () => {
  expect(authClient.signIn.social).toBeFunction();
  expect(signInWithGoogle).toBeFunction();
});

test("starts OAuth through a top-level API route with a trusted return origin", () => {
  expect(googleSignInUrl("https://openbot.example.com")).toBe(
    "/api/auth/google/start?callbackURL=https%3A%2F%2Fopenbot.example.com",
  );
});
