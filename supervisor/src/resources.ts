/** Parse an optional Docker resource limit without silently accepting zero, NaN, or fractions. */
export function optionalPositiveInteger(
  environment: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = environment[name]?.trim();
  if (!raw) return undefined;

  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe positive integer`);
  }
  return value;
}
