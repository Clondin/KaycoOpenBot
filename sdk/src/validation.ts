const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function requireExtensionId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(
      `${label} must start with a lowercase letter and contain only lowercase letters, numbers, and single hyphens.`,
    );
  }
}

export function requireVersion(value: string): void {
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(
      "Extension versions must use semantic versioning, such as 1.2.0.",
    );
  }
}

export function requireLabel(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
  if (Array.from(value).length > 200) {
    throw new Error(`${label} must be 200 characters or fewer.`);
  }
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
}
