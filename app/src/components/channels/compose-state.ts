/**
 * The rules a compose screen follows before there is a channel to hold them.
 *
 * Pure helpers so recipient-cap and sendability behavior stay testable without rendering.
 */

export type Recipient = {
  id: string;
  name: string;
};

/**
 * A bounded Workroom roster. Six supports useful specialist teams without turning identity and
 * tool ownership into an unreadable crowd.
 */
export const MAX_RECIPIENTS = 6;

/** Add a coworker while preserving the existing roster once the room cap is reached. */
export function addRecipient(
  current: readonly Recipient[],
  next: Recipient,
): Recipient[] {
  if (current.some((recipient) => recipient.id === next.id)) {
    return [...current];
  }
  return current.length >= MAX_RECIPIENTS ? [...current] : [...current, next];
}

export function removeRecipient(
  current: readonly Recipient[],
  id: string,
): Recipient[] {
  return current.filter((recipient) => recipient.id !== id);
}

/** Whether this draft can start a channel. */
export function canSend(
  recipients: readonly Recipient[],
  text: string,
): boolean {
  return (
    recipients.length > 0 &&
    recipients.length <= MAX_RECIPIENTS &&
    text.trim().length > 0
  );
}
