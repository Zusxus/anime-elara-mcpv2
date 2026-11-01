
/**
 * Anime Elara MCP Worker
 * Version: 1.0.0
 *
 * MCP tools:
 * - search_anime
 * - research_anime
 * - create_anime_draft
 * - get_draft
 * - list_drafts
 * - update_draft_synopsis
 * - select_draft_images
 * - acknowledge_draft_issues
 * - compose_anime_post
 * - archive_draft
 * - publish_anime_draft
 *
 * Publishing is always explicit.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

import type {
  DraftRecord,
  Env,
  PreparedPost,
  SourceIds,
} from "./types";

import {
  searchAnime,
  researchAnime,
  createDraft,
  getDraft,
  listDrafts,
  updateDraftSynopsis,
  selectDraftImages,
  acknowledgeDraftIssues,
  composeDraftPost,
  archiveDraft,
  getEngineInfo,
} from "./engine";

// ============================================================
// ENVIRONMENT
// ============================================================

function getEnv(): Env {
  return workerEnv as unknown as Env;
}

function validateEnvironment(env: Env): string | null {
  if (!env.MCP_ACCESS_TOKEN) {
    return "MCP_ACCESS_TOKEN is missing.";
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return "TELEGRAM_BOT_TOKEN is missing.";
  }

  if (!env.TMDB_READ_TOKEN) {
    return "TMDB_READ_TOKEN is missing.";
  }

  if (!env.DB) {
    return "D1 database binding is missing.";
  }

  return null;
}

// ============================================================
// MCP RESPONSE HELPERS
// ============================================================

function successResult(value: unknown) {
  const output =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : "An unexpected error occurred.";

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

async function executeTool<T>(
  action: () => Promise<T>,
) {
  try {
    const result = await action();
    return successResult(result);
  } catch (error) {
    return errorResult(error);
  }
}

// ============================================================
// INPUT SCHEMAS
// ============================================================

const SourceIdsSchema = z.object({
  tmdbId: z.number().int().positive().nullable().optional(),
  tmdbKind: z.enum(["tv", "movie"]).nullable().optional(),
  aniListId: z.number().int().positive().nullable().optional(),
  malId: z.number().int().positive().nullable().optional(),
  kitsuId: z.string().min(1).nullable().optional(),
});

function normalizeIds(
  input: z.infer<typeof SourceIdsSchema>,
): SourceIds {
  return {
    tmdbId: input.tmdbId ?? null,
    tmdbKind: input.tmdbKind ?? null,
    aniListId: input.aniListId ?? null,
    malId: input.malId ?? null,
    kitsuId: input.kitsuId ?? null,
  };
}

function hasAnySourceId(ids: SourceIds): boolean {
  return Boolean(
    ids.tmdbId ||
    ids.aniListId ||
    ids.kitsuId,
  );
}

// ============================================================
// TELEGRAM API
// ============================================================

type TelegramResponse = {
  ok: boolean;
  description?: string;
  result?: unknown;
  error_code?: number;
};

type TelegramSendResult = {
  ok: boolean;
  messageIds: number[];
  error: string | null;
};

async function telegramRequest(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<TelegramResponse> {
  const endpoint =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const raw = await response.text();

  let result: TelegramResponse;

  try {
    result = JSON.parse(raw) as TelegramResponse;
  } catch {
    throw new Error(
      "Telegram returned an unreadable response. Publication outcome is uncertain.",
    );
  }

  if (!response.ok || result.ok !== true) {
    return {
      ...result,
      ok: false,
      description:
        result.description ??
        `Telegram HTTP ${response.status}`,
    };
  }

  return result;
}

function extractMessageIds(
  result: unknown,
): number[] {
  if (Array.isArray(result)) {
    return result
      .map((item) => {
        if (!item || typeof item !== "object") return null;

        const id = (item as Record<string, unknown>).message_id;

        return typeof id === "number" ? id : null;
      })
      .filter((id): id is number => id !== null);
  }

  if (result && typeof result === "object") {
    const id = (result as Record<string, unknown>).message_id;

    if (typeof id === "number") return [id];
  }

  return [];
}

function validatePreparedPost(
  draft: DraftRecord,
): PreparedPost {
  const post = draft.post;

  if (!post) {
    throw new Error(
      "المسودة لا تحتوي على منشور مجهز. نفّذ compose_anime_post أولاً.",
    );
  }

  if (post.draftId !== draft.id) {
    throw new Error("معرّف المسودة لا يتطابق مع المنشور.");
  }

  if (post.draftVersion !== draft.version) {
    throw new Error(
      "نسخة المنشور قديمة. أعد تجهيز المنشور قبل النشر.",
    );
  }

  if (!post.contentHash || post.contentHash.length !== 64) {
    throw new Error("بصمة محتوى المنشور غير صالحة.");
  }

  if (!Array.isArray(post.imageUrls) || post.imageUrls.length === 0) {
    throw new Error("المنشور لا يحتوي على صور.");
  }

  if (post.imageUrls.length > 10) {
    throw new Error("عدد الصور يتجاوز الحد المسموح.");
  }

  for (const value of post.imageUrls) {
    try {
      const url = new URL(value);

      if (url.protocol !== "https:") {
        throw new Error();
      }
    } catch {
      throw new Error("أحد روابط الصور غير صالح.");
    }
  }

  if (!post.caption || post.caption.length > 1024) {
    throw new Error(
      "نص وصف الصورة غير صالح أو يتجاوز حد Telegram.",
    );
  }

  return post;
}

// ============================================================
// DRAFT PUBLICATION
// ============================================================

async function claimDraftForPublishing(
  env: Env,
  draft: DraftRecord,
): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE drafts
    SET
      status = 'publishing',
      version = version + 1,
      updated_at_utc = ?
    WHERE id = ?
      AND status = 'open'
      AND version = ?
      AND post_json IS NOT NULL
  `)
    .bind(
      new Date().toISOString(),
      draft.id,
      draft.version,
    )
    .run();

  return result.success && result.meta.changes === 1;
}

async function setDraftPublicationStatus(
  env: Env,
  draftId: string,
  status: "published" | "open" | "publish_unknown",
): Promise<void> {
  const result = await env.DB.prepare(`
    UPDATE drafts
    SET
      status = ?,
      updated_at_utc = ?
    WHERE id = ?
      AND status = 'publishing'
  `)
    .bind(
      status,
      new Date().toISOString(),
      draftId,
    )
    .run();

  if (!result.success || result.meta.changes !== 1) {
    throw new Error(
      "تعذر تحديث حالة النشر في قاعدة البيانات. لا تعاود الإرسال تلقائياً.",
    );
  }
}

async function sendPreparedPost(
  env: Env,
  post: PreparedPost,
): Promise<TelegramSendResult> {
  if (post.imageUrls.length === 1) {
    const response = await telegramRequest(
      env,
      "sendPhoto",
      {
        chat_id: "@anime_elara",
        photo: post.imageUrls[0],
        caption: post.caption,
        parse_mode: "HTML",
      },
    );

    return {
      ok: response.ok,
      messageIds: extractMessageIds(response.result),
      error: response.description ?? null,
    };
  }

  const media = post.imageUrls.map((url, index) => {
    if (index === 0) {
      return {
        type: "photo",
        media: url,
        caption: post.caption,
        parse_mode: "HTML",
      };
    }

    return {
      type: "photo",
      media: url,
    };
  });

  const response = await telegramRequest(
    env,
    "sendMediaGroup",
    {
      chat_id: "@anime_elara",
      media,
    },
  );

  return {
    ok: response.ok,
    messageIds: extractMessageIds(response.result),
    error: response.description ?? null,
  };
}

async function publishDraft(
  env: Env,
  draftId: string,
) {
  const draft = await getDraft(env, draftId);

  if (!draft) {
    throw new Error("المسودة غير موجودة.");
  }

  if (draft.status === "published") {
    throw new Error(
      "هذه المسودة منشورة بالفعل. لن يتم تكرار النشر.",
    );
  }

  if (draft.status !== "open") {
    throw new Error(
      `لا يمكن النشر من الحالة الحالية: ${draft.status}.`,
    );
  }

  const post = validatePreparedPost(draft);

  const claimed = await claimDraftForPublishing(env, draft);

  if (!claimed) {
    throw new Error(
      "لم يتم حجز المسودة للنشر. ربما تم تعديلها أو بدأ نشرها من طلب آخر.",
    );
  }

  let telegramResult: TelegramSendResult;

  try {
    telegramResult = await sendPreparedPost(env, post);
  } catch {
    // A network failure after sending may mean Telegram received the post.
    await setDraftPublicationStatus(
      env,
      draftId,
      "publish_unknown",
    );

    return {
      success: false,
      status: "publish_unknown",
      message:
        "انقطع الاتصال أثناء محاولة النشر. لا نعرف إن كان Telegram قد استلم المنشور. تم إيقاف إعادة المحاولة التلقائية لمنع التكرار.",
      draftId,
    };
  }

  if (!telegramResult.ok) {
    await setDraftPublicationStatus(
      env,
      draftId,
      "open",
    );

    return {
      success: false,
      status: "open",
      message:
        telegramResult.error ??
        "رفض Telegram عملية النشر.",
      draftId,
    };
  }

  await setDraftPublicationStatus(
    env,
    draftId,
    "published",
  );

  return {
    success: true,
    status: "published",
    draftId,
    telegramMessageIds: telegramResult.messageIds,
    message:
      "تم نشر منشور الأنمي في قناة Anime Elara بنجاح.",
  };
}

// ============================================================
// MCP SERVER
// ============================================================

function createServer() {
  const server = new McpServer({
    name: "Anime Elara",
    version: "1.0.0",
  });

  const env = getEnv();

  // ----------------------------------------------------------
  // 1. SEARCH ANIME
  // ----------------------------------------------------------

  server.registerTool(
    "search_anime",
    {
      description:
        "Search anime across TMDB, AniList and Kitsu. Returns candidate titles and source IDs. Does not create or publish anything.",
      inputSchema: z.object({
        query: z.string().min(2).max(150),
        maxResults: z.number().int().min(1).max(8).optional(),
      }),
    },
    async ({ query, maxResults }) =>
      executeTool(() =>
        searchAnime(env, query, maxResults ?? 8),
      ),
  );

  // ----------------------------------------------------------
  // 2. RESEARCH ANIME
  // ----------------------------------------------------------

  server.registerTool(
    "research_anime",
    {
      description:
        "Retrieve detailed anime information from selected source IDs, classify the work, compare source data, collect images and report conflicts. Does not create or publish a post.",
      inputSchema: z.object({
        ids: SourceIdsSchema,
      }),
    },
    async ({ ids }) =>
      executeTool(async () => {
        const normalized = normalizeIds(ids);

        if (!hasAnySourceId(normalized)) {
          throw new Error(
            "يجب توفير TMDB ID أو AniList ID أو Kitsu ID.",
          );
        }

        return researchAnime(env, normalized);
      }),
  );

  // ----------------------------------------------------------
  // 3. CREATE DRAFT
  // ----------------------------------------------------------

  server.registerTool(
    "create_anime_draft",
    {
      description:
        "Create and save one anime post draft using source IDs. Optional Arabic synopsis and Arabic title can be supplied. Never publishes.",
      inputSchema: z.object({
        ids: SourceIdsSchema,
        synopsisArabic: z.string().max(1024).optional(),
        arabicTitle: z.string().max(150).optional(),
      }),
    },
    async ({ ids, synopsisArabic, arabicTitle }) =>
      executeTool(async () => {
        const normalized = normalizeIds(ids);

        if (!hasAnySourceId(normalized)) {
          throw new Error("لا توجد معرفات مصادر صالحة.");
        }

        return createDraft(env, {
          ids: normalized,
          synopsisArabic,
          arabicTitle,
        });
      }),
  );

  // ----------------------------------------------------------
  // 4. GET DRAFT
  // ----------------------------------------------------------

  server.registerTool(
    "get_draft",
    {
      description:
        "Retrieve a saved anime draft, its source information, issues, selected images and prepared post.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
      }),
    },
    async ({ draftId }) =>
      executeTool(async () => {
        const draft = await getDraft(env, draftId);

        if (!draft) {
          throw new Error("المسودة غير موجودة.");
        }

        return draft;
      }),
  );

  // ----------------------------------------------------------
  // 5. LIST DRAFTS
  // ----------------------------------------------------------

  server.registerTool(
    "list_drafts",
    {
      description:
        "List saved anime drafts. Use status all, open, published or archived.",
      inputSchema: z.object({
        status: z.enum([
          "all",
          "open",
          "published",
          "archived",
        ]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ status, limit }) =>
      executeTool(() =>
        listDrafts(
          env,
          status ?? "all",
          limit ?? 20,
        ),
      ),
  );

  // ----------------------------------------------------------
  // 6. UPDATE ARABIC SYNOPSIS
  // ----------------------------------------------------------

  server.registerTool(
    "update_draft_synopsis",
    {
      description:
        "Update the Arabic synopsis and optionally the Arabic title of an open draft. This invalidates the previous prepared post.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
        synopsisArabic: z.string().min(1).max(1024),
        arabicTitle: z.string().max(150).optional(),
      }),
    },
    async ({ draftId, synopsisArabic, arabicTitle }) =>
      executeTool(() =>
        updateDraftSynopsis(
          env,
          draftId,
          synopsisArabic,
          arabicTitle,
        ),
      ),
  );

  // ----------------------------------------------------------
  // 7. SELECT IMAGES
  // ----------------------------------------------------------

  server.registerTool(
    "select_draft_images",
    {
      description:
        "Select between one and ten images from the images already collected for a draft. This invalidates the previous prepared post.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
        imageUrls: z.array(
          z.string().url(),
        ).min(1).max(10),
      }),
    },
    async ({ draftId, imageUrls }) =>
      executeTool(() =>
        selectDraftImages(
          env,
          draftId,
          imageUrls,
        ),
      ),
  );

  // ----------------------------------------------------------
  // 8. ACKNOWLEDGE WARNINGS
  // ----------------------------------------------------------

  server.registerTool(
    "acknowledge_draft_issues",
    {
      description:
        "Acknowledge reviewable warnings in a draft. Blocking issues cannot be bypassed.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
        issueCodes: z.array(
          z.string().min(1),
        ).min(1).max(20),
      }),
    },
    async ({ draftId, issueCodes }) =>
      executeTool(() =>
        acknowledgeDraftIssues(
          env,
          draftId,
          issueCodes,
        ),
      ),
  );

  // ----------------------------------------------------------
  // 9. COMPOSE POST
  // ----------------------------------------------------------

  server.registerTool(
    "compose_anime_post",
    {
      description:
        "Prepare the final Arabic Telegram post from an open draft. Requires a reviewed Arabic synopsis, selected image and resolved issues. Does not publish.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
      }),
    },
    async ({ draftId }) =>
      executeTool(async () => {
        return composeDraftPost(env, draftId);
      }),
  );

  // ----------------------------------------------------------
  // 10. ARCHIVE DRAFT
  // ----------------------------------------------------------

  server.registerTool(
    "archive_draft",
    {
      description:
        "Archive an open anime draft. Published or currently publishing drafts cannot be archived.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
      }),
    },
    async ({ draftId }) =>
      executeTool(async () => {
        const archived = await archiveDraft(env, draftId);

        if (!archived) {
          throw new Error(
            "لم تتم أرشفة المسودة. ربما تغيرت حالتها.",
          );
        }

        return {
          success: true,
          draftId,
          status: "archived",
        };
      }),
  );

  // ----------------------------------------------------------
  // 11. PUBLISH DRAFT
  // ----------------------------------------------------------

  server.registerTool(
    "publish_anime_draft",
    {
      description:
        "Publish one already prepared anime draft to the Anime Elara Telegram channel. This is the ONLY publishing tool. Call it only after the user explicitly instructs you to publish. Never call it merely because a draft is ready.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
      }),
    },
    async ({ draftId }) =>
      executeTool(() =>
        publishDraft(env, draftId),
      ),
  );

  // ----------------------------------------------------------
  // 12. ENGINE INFO
  // ----------------------------------------------------------

  server.registerTool(
    "anime_elara_status",
    {
      description:
        "Return the Anime Elara engine capabilities and publishing mode.",
      inputSchema: z.object({}),
    },
    async () =>
      executeTool(() => Promise.resolve({
        ...getEngineInfo(),
        databaseAvailable: Boolean(env.DB),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
        tmdbConfigured: Boolean(env.TMDB_READ_TOKEN),
      })),
  );

  return server;
}

// ============================================================
// MCP HANDLER
// ============================================================

const mcpHandler = createMcpHandler(createServer);

// ============================================================
// CLOUDFLARE WORKER ENTRY
// ============================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Do not expose the MCP endpoint without the secret path.
    if (!env.MCP_ACCESS_TOKEN) {
      return new Response(
        "Service configuration error",
        { status: 503 },
      );
    }

    const protectedPath =
      `/s/${env.MCP_ACCESS_TOKEN}/mcp`;

    if (url.pathname !== protectedPath) {
      return new Response(
        "Not Found",
        { status: 404 },
      );
    }

    const configurationError =
      validateEnvironment(env);

    if (configurationError) {
      return new Response(
        "Service configuration error",
        { status: 503 },
      );
    }

    return mcpHandler(request, env, ctx);
  },
};
