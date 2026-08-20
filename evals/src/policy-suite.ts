import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
} from "../../server/src/computer/policy.ts";
import { runEvalSuite } from "./runner.ts";

type ExpectedDecision = Pick<
  PolicyDecision,
  "source" | "forward" | "approvalRequired"
>;

type PolicyCase = {
  id: string;
  policy: ActionPolicy;
  context: PolicyContext;
  expected: ExpectedDecision;
};

const caseFile = new URL("../cases/policy.yaml", import.meta.url);
const parsed = parse(await readFile(caseFile, "utf8")) as {
  cases?: PolicyCase[];
};
const cases = parsed.cases ?? [];
if (cases.length === 0) throw new Error("The policy eval suite has no cases.");

const report = await runEvalSuite({
  name: "action-policy",
  cases: cases.map((evalCase) => ({
    id: evalCase.id,
    input: { policy: evalCase.policy, context: evalCase.context },
    expected: evalCase.expected,
  })),
  execute: ({ policy, context }) => evaluateActionPolicy(policy, context),
  grade: (output, expected) => {
    for (const key of ["source", "forward", "approvalRequired"] as const) {
      if (output[key] !== expected[key]) {
        return `Expected ${key}=${String(expected[key])}, received ${String(output[key])}.`;
      }
    }
    return true;
  },
});

const serialised = `${JSON.stringify(report, null, 2)}\n`;
const reportPath = process.env.OPENBOT_EVAL_REPORT?.trim();
if (reportPath) await writeFile(reportPath, serialised, "utf8");
console.info(serialised.trim());

const threshold = Number.parseFloat(process.env.OPENBOT_EVAL_THRESHOLD ?? "1");
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  throw new Error("OPENBOT_EVAL_THRESHOLD must be between 0 and 1.");
}
if (report.passRate < threshold) process.exitCode = 1;
