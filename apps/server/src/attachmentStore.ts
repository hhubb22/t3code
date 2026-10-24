// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import {
  ATTACHMENT_ID_PATTERN,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  attachmentIdExtensionSuffix,
  createAttachmentId,
  normalizeAttachmentRelativePath,
  parseAttachmentFileExtension,
  resolveAttachmentPathById,
  resolveAttachmentRelativePath,
  toSafeThreadAttachmentSegment,
} from "@t3tools/provider-codex/server/attachmentFiles";

export {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  attachmentFileExtension,
  attachmentRelativePath,
  createAttachmentId,
  parseAttachmentFileExtension,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "@t3tools/provider-codex/server/attachmentFiles";

const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

export function createPendingAttachmentId(extension?: string): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function parseAttachmentUuid(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[2]?.toLowerCase() ?? null;
}

export function createDeterministicAttachmentId(
  threadId: string,
  stableKey: string,
): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) return null;
  const hash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([threadId, stableKey]))
    .digest("hex")
    .slice(0, 32);
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
  return `${threadSegment}-${uuid}`;
}

/**
 * A retry resends the same bytes and keeps its id. Editing a queued message
 * reuses the message id, so the bytes also stop a new image from taking an
 * earlier image's id and file. Clients cache attachment images by id, which
 * relies on ids never changing bytes.
 */
export function chatAttachmentStableKey(
  messageId: string,
  index: number,
  bytes: Uint8Array,
): string {
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return `${messageId}:${index}:${digest}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

/**
 * Only ids minted for this thread count, so deleting a fork never removes its
 * source's pages.
 */
export function threadHtmlRenderAttachmentIds(
  threadId: string,
  items: Iterable<{ readonly toolName: string | null | undefined; readonly output?: unknown }>,
) {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (segment === null) return [];
  return Array.from(items).flatMap((item) => {
    const attachmentId =
      htmlRenderFromToolItem(item)?.attachmentId ?? mcpAppFromToolItem(item)?.attachmentId;
    return attachmentId !== undefined &&
      parseThreadSegmentFromAttachmentId(attachmentId) === segment
      ? [attachmentId]
      : [];
  });
}

export type AttachmentClaimPlan =
  | {
      readonly ok: true;
      readonly finalId: string;
      readonly currentPath: string;
      readonly finalPath: string;
    }
  | { readonly ok: false; readonly reason: string };

export function planAttachmentClaim(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentId: string;
}): AttachmentClaimPlan {
  const uuid = parseAttachmentUuid(input.attachmentId);
  const requestedSegment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (!uuid || !requestedSegment) {
    return { ok: false, reason: "invalid attachment id" };
  }

  if (!toSafeThreadAttachmentSegment(input.threadId)) {
    return { ok: false, reason: "invalid thread id" };
  }
  if (requestedSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return { ok: false, reason: "attachment must be a pending upload" };
  }

  const currentPath = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (!currentPath) {
    return { ok: false, reason: "attachment not found (removed or expired)" };
  }
  const fileExtension = parseAttachmentFileExtension(input.attachmentId) ?? undefined;
  const finalId = createAttachmentId(input.threadId, fileExtension);
  if (!finalId) {
    return { ok: false, reason: "failed to create attachment id" };
  }

  const expectedFinalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${NodePath.extname(currentPath)}`,
  });
  if (!expectedFinalPath) {
    return { ok: false, reason: "failed to resolve attachment path" };
  }
  return {
    ok: true,
    finalId,
    currentPath,
    finalPath: expectedFinalPath,
  };
}

export function sweepStalePendingAttachments(input: {
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): { readonly deleted: number } {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const entry of entries) {
    const isPartial = entry.endsWith(".part");
    if (!isPartial) {
      const attachmentId = parseAttachmentIdFromRelativePath(entry);
      if (
        !attachmentId ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
      ) {
        continue;
      }
    }

    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (!resolved) {
      continue;
    }
    try {
      const maxAgeMs = isPartial ? PARTIAL_UPLOAD_MAX_AGE_MS : PENDING_ATTACHMENT_MAX_AGE_MS;
      if (input.nowMs - NodeFS.statSync(resolved).mtimeMs > maxAgeMs) {
        NodeFS.unlinkSync(resolved);
        deleted += 1;
      }
    } catch {
      continue;
    }
  }

  return { deleted };
}

function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
