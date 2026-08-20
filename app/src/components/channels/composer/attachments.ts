import type { InputContent } from "@ag-ui/core";

export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type ComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  data: string;
  kind: "image" | "audio" | "video" | "document" | "binary";
};

function attachmentKind(mimeType: string): ComposerAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf" ||
    mimeType.includes("document") ||
    mimeType.includes("sheet") ||
    mimeType.includes("presentation")
  ) {
    return "document";
  }
  return "binary";
}

export async function attachmentFromFile(
  file: File,
): Promise<ComposerAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than 5 MB.`);
  }
  const mimeType = file.type || "application/octet-stream";
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error(`${file.name} could not be encoded.`);
  return {
    id: crypto.randomUUID(),
    name: file.name.slice(0, 180),
    mimeType,
    bytes: file.size,
    data: dataUrl.slice(comma + 1),
    kind: attachmentKind(mimeType),
  };
}

export function attachmentInputPart(
  attachment: ComposerAttachment,
): InputContent {
  if (attachment.kind === "binary") {
    return {
      type: "binary",
      mimeType: attachment.mimeType,
      data: attachment.data,
      filename: attachment.name,
    };
  }
  return {
    type: attachment.kind,
    source: {
      type: "data",
      value: attachment.data,
      mimeType: attachment.mimeType,
    },
    metadata: { filename: attachment.name, bytes: attachment.bytes },
  };
}

export function canAddAttachments(
  current: readonly ComposerAttachment[],
  incoming: readonly File[],
): string | null {
  if (current.length + incoming.length > MAX_ATTACHMENT_COUNT) {
    return `Attach at most ${MAX_ATTACHMENT_COUNT} files.`;
  }
  if (
    current.reduce((total, item) => total + item.bytes, 0) +
      incoming.reduce((total, file) => total + file.size, 0) >
    MAX_TOTAL_ATTACHMENT_BYTES
  ) {
    return "Attachments can total at most 10 MB.";
  }
  return null;
}
