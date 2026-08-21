import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  classifyModelFailure,
  type ModelFailureCode,
} from "../src/autonomy/routing";
import { searchTools } from "../src/autonomy/tool-catalog";
import type { GrantedTool } from "../src/plugins/tools";

function tool(name: string, description: string): GrantedTool {
  return {
    name,
    description,
    parameters: z.object({}),
    execute: async () => "ok",
  };
}

describe("autonomy foundations", () => {
  test("classifies only recognizable transient model failures for fallback", () => {
    const cases: Array<[string, ModelFailureCode]> = [
      ["429 rate limit exceeded", "rate_limit"],
      ["request timed out", "timeout"],
      ["503 provider unavailable", "unavailable"],
      ["401 invalid API key", "authentication"],
      ["maximum context length", "context_limit"],
      ["the response was malformed", "other"],
    ];
    for (const [message, expected] of cases) {
      expect(classifyModelFailure(new Error(message))).toBe(expected);
    }
  });

  test("searches only the already-granted tool catalogue", () => {
    const tools = [
      tool("mcp__slack__search", "Search messages in Slack channels"),
      tool("mcp__slack__post", "Post a new Slack message"),
      tool("mcp__drive__search", "Search Google Drive documents"),
    ];
    expect(searchTools(tools, "slack search", 2)).toEqual([
      {
        name: "mcp__slack__search",
        description: "Search messages in Slack channels",
      },
      {
        name: "mcp__drive__search",
        description: "Search Google Drive documents",
      },
    ]);
    expect(searchTools(tools, "github", 5)).toEqual([]);
  });
});
