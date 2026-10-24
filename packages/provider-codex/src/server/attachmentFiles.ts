// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import {
  inferImageExtension,
  SAFE_IMAGE_FILE_EXTENSIONS,
} from "@t3tools/provider-core/server/imageExtension";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_FILE_EXTENSION_PATTERN = "[a-z0-9]{1,10}";
export const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})(?:-(${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}))?$`,
  "i",
);

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = NodePath.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

export function resolveAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const attachmentsRoot = NodePath.resolve(input.attachmentsDir);
  const filePath = NodePath.resolve(NodePath.join(attachmentsRoot, normalizedRelativePath));
  if (!filePath.startsWith(`${attachmentsRoot}${NodePath.sep}`)) {
    return null;
  }
  return filePath;
}

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

export function attachmentFileExtension(fileName: string): string {
  const extension = NodePath.extname(fileName).toLowerCase();
  // ".part" is reserved for in-flight uploads; a stored "archive.part" would
  // look stale to sweepStalePendingAttachments and get deleted.
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return ".bin";
  }
  return extension;
}

export function attachmentIdExtensionSuffix(extension: string | undefined): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return new RegExp(`^${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}$`).test(normalized)
    ? `-${normalized}`
    : "-bin";
}

export function parseAttachmentFileExtension(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[3]?.toLowerCase() ?? null;
}

export function createAttachmentId(threadId: string, extension?: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function attachmentRelativePath(attachment: ChatAttachment): string | null {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file":
      return `${attachment.id}${attachmentFileExtension(attachment.name)}`;
    default:
      return null;
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const relativePath = attachmentRelativePath(input.attachment);
  if (!relativePath) {
    return null;
  }
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const fileExtension = parseAttachmentFileExtension(normalizedId);
  if (fileExtension) {
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}.${fileExtension.toLowerCase()}`,
    });
    return filePath && NodeFS.existsSync(filePath) ? filePath : null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}
