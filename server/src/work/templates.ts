export type WorkTemplate = {
  id: string;
  title: string;
  summary: string;
  trigger: "manual" | "schedule" | "webhook";
  integrationLabels: string[];
  agentRole: string;
  instruction: string;
};

/**
 * Reviewed starting points for repeatable cross-system work. Templates create ordinary routines:
 * a person can inspect and edit every instruction, trigger, project, and Bot before it runs.
 */
export const WORK_TEMPLATES: readonly WorkTemplate[] = Object.freeze([
  {
    id: "daily-executive-brief",
    title: "Daily executive brief",
    summary:
      "Turn the latest project documents and team updates into a cited morning brief.",
    trigger: "schedule",
    integrationLabels: ["Google Drive", "Slack"],
    agentRole: "Research or operations",
    instruction:
      "Review the project’s newly changed source documents and relevant team updates since the last successful run. Produce a concise executive brief with: decisions, material changes, blockers, owners, deadlines, and source links. Separate verified facts from inferences. Save the finished brief as a project artifact. Do not send or publish it without approval.",
  },
  {
    id: "customer-request-triage",
    title: "Customer request triage",
    summary:
      "Receive a request, gather account context, and prepare a routed response with approvals.",
    trigger: "webhook",
    integrationLabels: ["Salesforce", "Slack", "Atlassian"],
    agentRole: "Customer operations",
    instruction:
      "Triage the incoming customer request. Identify the account, urgency, product area, and any related open work. Draft a factual response and a recommended owner. Create or update internal work only when the evidence supports it. Treat any customer-facing message or record-changing action as approval-required. Save the triage summary and source links as a project artifact.",
  },
  {
    id: "incident-coordinator",
    title: "Incident coordinator",
    summary:
      "Build a live, source-backed incident picture and keep handoffs explicit.",
    trigger: "webhook",
    integrationLabels: ["Slack", "Atlassian", "ServiceNow"],
    agentRole: "Operations",
    instruction:
      "Coordinate the incoming incident without making unapproved production changes. Gather current alerts, recent changes, affected services, owners, and customer impact. Maintain a timestamped incident summary, open questions, and recommended next actions. Delegate bounded research tasks to specialist coworkers where useful. Require approval before posting externally, changing records, or executing remediation. Save each material update as a project artifact.",
  },
  {
    id: "weekly-project-review",
    title: "Weekly project review",
    summary:
      "Reconcile plans, artifacts, and open work into a decision-ready review.",
    trigger: "schedule",
    integrationLabels: ["Google Drive", "Atlassian"],
    agentRole: "Project manager",
    instruction:
      "Review the project’s current plan, recent artifacts, delegated tasks, and unresolved decisions. Produce a weekly review covering progress against outcomes, changes since the prior review, risks, blocked work, decisions needed, and the next seven days. Cite source links and label assumptions. Save the review as a project artifact; do not publish it outside OpenBot without approval.",
  },
]);
