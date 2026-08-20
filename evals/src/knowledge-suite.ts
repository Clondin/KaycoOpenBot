import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { canRead } from "../../server/src/knowledge/acl.ts";
import type {
  KnowledgeAclEntry,
  KnowledgeActor,
} from "../../server/src/knowledge/types.ts";
import { runEvalSuite } from "./runner.ts";

type KnowledgeCase = {
  id: string;
  actor: KnowledgeActor;
  acls: KnowledgeAclEntry[];
  expected: boolean;
};

const parsed = parse(
  await readFile(
    new URL("../cases/knowledge-acl.yaml", import.meta.url),
    "utf8",
  ),
) as { cases?: KnowledgeCase[] };
const cases = parsed.cases ?? [];
if (cases.length === 0)
  throw new Error("The knowledge ACL eval suite has no cases.");

const report = await runEvalSuite({
  name: "knowledge-acl",
  cases: cases.map((item) => ({
    id: item.id,
    input: { actor: item.actor, acls: item.acls },
    expected: item.expected,
  })),
  execute: ({ actor, acls }) => canRead(actor, acls),
  grade: (output, expected) =>
    output === expected
      ? true
      : `Expected access=${expected}, received access=${output}.`,
});

const serialised = `${JSON.stringify(report, null, 2)}\n`;
const reportPath = process.env.OPENBOT_KNOWLEDGE_EVAL_REPORT?.trim();
if (reportPath) await writeFile(reportPath, serialised, "utf8");
console.info(serialised.trim());

const threshold = Number.parseFloat(process.env.OPENBOT_EVAL_THRESHOLD ?? "1");
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  throw new Error("OPENBOT_EVAL_THRESHOLD must be between 0 and 1.");
}
if (report.passRate < threshold) process.exitCode = 1;
