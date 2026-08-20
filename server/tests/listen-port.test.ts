import { describe, expect, test } from "bun:test";
import { resolveListenPort } from "../src/listen-port";

describe("API listen port", () => {
  test("defaults to 3001", () => {
    expect(resolveListenPort({})).toBe(3001);
  });

  test("honours the legacy PORT setting", () => {
    expect(resolveListenPort({ PORT: "4001" })).toBe(4001);
  });

  test("prefers the documented SERVER_PORT setting", () => {
    expect(resolveListenPort({ SERVER_PORT: "4002", PORT: "4001" })).toBe(4002);
  });

  test("treats blank settings as unset", () => {
    expect(resolveListenPort({ SERVER_PORT: "  ", PORT: "4001" })).toBe(4001);
    expect(resolveListenPort({ SERVER_PORT: "", PORT: "" })).toBe(3001);
  });
});
