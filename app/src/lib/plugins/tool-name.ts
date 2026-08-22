/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * Anything that is not a prefixed MCP name is left exactly as it is: a component the app registered
 * already has a name somebody chose.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
};

/**
 * Present-tense labels for the built-in computer tools while they are running.
 *
 * Their protocol names are deliberately machine-shaped (`computer_navigate`), while the activity
 * bar is a sentence for the person watching. Keep this mapping separate from `readToolName`: that
 * function also names user-registered components, whose chosen names must remain untouched.
 */
const COMPUTER_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  computer_click: "Clicking",
  computer_extract_table: "Extracting table data",
  computer_fill_form: "Filling the form",
  computer_key: "Pressing a key",
  computer_list_files: "Listing files",
  computer_navigate: "Opening a page",
  computer_observe: "Observing the page",
  computer_read: "Reading the page",
  computer_read_file: "Reading a file",
  computer_request_help: "Asking for help",
  computer_request_secret: "Requesting a secret",
  computer_screenshot: "Capturing the screen",
  computer_scroll: "Scrolling",
  computer_snapshot: "Checking the page",
  computer_type: "Typing",
  computer_write_file: "Saving a file",
};

/** Plain-language label for the fixed activity bar while a tool is running. */
export function toolActivityLabel(name: string): string {
  return COMPUTER_ACTIVITY_LABELS[name] ?? readToolName(name).label;
}

export function readToolName(name: string): ToolName {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return { label: name };

  const [, server, ...rest] = parts;
  const tool = rest.join("__");
  const label = humanise(tool);

  /*
   * The server is dropped when the action already says it. Vendors name a tool after the thing it
   * searches, so `mcp__notes__search_notes` would otherwise read "Search notes notes", which looks
   * like a bug rather than a label.
   */
  const named = label.toLowerCase().includes((server ?? "").toLowerCase());
  return named ? { label } : { label, detail: server };
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
function humanise(tool: string): string {
  const words = tool
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
