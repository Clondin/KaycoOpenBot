import { describe, expect, test } from "bun:test";
import {
  MAX_TEAM_MEMBERS,
  parseTeamTemplate,
  teamTemplateFrom,
} from "../src/agents/team-template";
import type { AgentProfile } from "../src/agents/profile-types";

function profile(): AgentProfile {
  return {
    id: "secret-id",
    name: "Invoice Helper",
    title: "Finance",
    roleDescription: "Organizes invoices.",
    avatarSeed: "private-seed",
    visibility: "private",
    ownerUserId: "user-1",
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint: "https://private.example.test/agent",
    hasAuth: true,
    hasCallbackToken: true,
  };
}

describe("team templates", () => {
  test("exports persona fields and nothing operational", () => {
    expect(teamTemplateFrom("Finance team", [profile()])).toEqual({
      schema: "kayco.openbot.team",
      version: 1,
      name: "Finance team",
      coworkers: [
        {
          name: "Invoice Helper",
          title: "Finance",
          roleDescription: "Organizes invoices.",
        },
      ],
    });
  });

  test("drops unknown and sensitive-looking fields while importing", () => {
    expect(
      parseTeamTemplate({
        schema: "kayco.openbot.team",
        version: 1,
        name: " Finance team ",
        credentials: { token: "do-not-import" },
        coworkers: [
          {
            name: " Invoice Helper ",
            title: " Finance ",
            roleDescription: " Organizes invoices. ",
            id: "forged-id",
            endpoint: "https://attacker.test",
            visibility: "public",
            grants: ["admin"],
          },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        schema: "kayco.openbot.team",
        version: 1,
        name: "Finance team",
        coworkers: [
          {
            name: "Invoice Helper",
            title: "Finance",
            roleDescription: "Organizes invoices.",
          },
        ],
      },
    });
  });

  test("rejects unsupported versions and oversized teams", () => {
    const member = {
      name: "Helper",
      title: "General",
      roleDescription: "Helps.",
    };
    expect(
      parseTeamTemplate({
        schema: "kayco.openbot.team",
        version: 2,
        name: "Team",
        coworkers: [member],
      }).ok,
    ).toBe(false);
    expect(
      parseTeamTemplate({
        schema: "kayco.openbot.team",
        version: 1,
        name: "Team",
        coworkers: Array.from({ length: MAX_TEAM_MEMBERS + 1 }, () => member),
      }).ok,
    ).toBe(false);
  });
});
