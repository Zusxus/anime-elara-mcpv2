
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

declare global {
  interface Env {
    TELEGRAM_BOT_TOKEN: string;
    MCP_ACCESS_TOKEN: string;
    TMDB_READ_TOKEN: string;
  }
}

const CHANNEL = "@anime_elara";
const TENRAI_API = "https://api.tenrai.org/v1";
const TMDB_API = "https://api.themoviedb.org/3";
const TELEGRAM_API = `https://api.telegram.org/bot${workerEnv.TELEGRAM_BOT_TOKEN}`;

const MAX_PHOTO_SIZE = 9 * 1024 * 1024;
const MAX_ALBUM_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_ALBUM_TOTAL_SIZE = 25 * 1024 * 1024;

type TelegramResult = {
  ok?: boolean;
  description?: string;
  result?: unknown;
};

type ImageFormat = {
  image_url?: string;
  large_image_url?: string;
};

type ImageSet = {
  jpg?: ImageFormat;
  webp?: ImageFormat;
};

type AnimeEntry = {
  mal_id: number;
  name?: string;
  title?: string;
  url?: string;
  images?: ImageSet;
};

// Picture endpoints return jpg/webp directly, unlike search endpoints.
type PictureEntry = ImageSet;

type TenraiPayload<T> = {
  data?: T[];
  message?: string;
  error?: string;
  type?: string;
};

class TenraiApiError extends Error {
  status: number;
  endpoint: string;
  retryAfter: string | null;
  rateLimitHeaders: Record<string, string>;
  responseBody: string;

  constructor(
    message: string,
    status: number,
    endpoint: string,
    retryAfter: string | null,
    rateLimitHeaders: Record<string, string>,
    responseBody: string,
  ) {
    super(message);
    this.name = "TenraiApiError";
    this.status = status;
    this.endpoint = endpoint;
    this.retryAfter = retryAfter;
    this.rateLimitHeaders = rateLimitHeaders;
    this.responseBody = responseBody;
  }
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function safeEndpoint(path: string): string {
  // Only API path/query is reported; no secrets or authorization data.
  return `${TENRAI_API}${path}`;
}

function getRateLimitHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();

    if (
      lower === "retry-after" ||
      lower.includes("ratelimit") ||
      lower.includes("rate-limit") ||
      lower.includes("quota")
    ) {
      selected[name] = value;
    }
  }

  return selected;
}

function parseTenraiBody<T>(raw: string): TenraiPayload<T> | null {
  try {
    return JSON.parse(raw) as TenraiPayload<T>;
  } catch {
    return null;
  }
}

// One request only. No automatic retries.
async function tenraiRequest<T>(path: string) {
  const endpoint = safeEndpoint(path);
  const started = Date.now();

  let response: Response;

  try {
    response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const elapsedMs = Date.now() - started;

    throw new Error(
      `Tenrai network/timeout error after ${elapsedMs}ms for ${path}: ${String(error)}`,
    );
  }

  const elapsedMs = Date.now() - started;
  const raw = await response.text();
  const payload = parseTenraiBody<T>(raw);
  const retryAfter = response.headers.get("retry-after");
  const rateLimitHeaders = getRateLimitHeaders(response.headers);

  if (!response.ok || !payload || !Array.isArray(payload.data)) {
    const message =
      payload?.message ||
      payload?.error ||
      payload?.type ||
      (response.status === 429
        ? "Tenrai rate limit exceeded"
        : `Tenrai API error: HTTP ${response.status}`);

    throw new TenraiApiError(
      message,
      response.status,
      path,
      retryAfter,
      rateLimitHeaders,
      raw.slice(0, 700),
    );
  }

  return {
    data: payload.data,
    status: response.status,
    elapsedMs,
    retryAfter,
    rateLimitHeaders,
    endpointPath: path,
  };
}

async function tenraiGet<T>(path: string): Promise<T[]> {
  const result = await tenraiRequest<T>(path);
  return result.data;
}

// Telegram JSON request
async function telegramJson(
  method: string,
  data: Record<string, unknown>,
) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const result = (await response.json()) as TelegramResult;

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram HTTP ${response.status}`,
    );
  }

  return result;
}

// Telegram multipart upload
async function telegramForm(method: string, form: FormData) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    body: form,
  });

  const result = (await response.json()) as TelegramResult;

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram HTTP ${response.status}`,
    );
  }

  return result;
}

// Download and validate an image before uploading it.
async function downloadImage(
  imageUrl: string,
  maxBytes: number,
): Promise<{ blob: Blob; type: string }> {
  const url = new URL(imageUrl);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal") ||
    url.hostname.startsWith("[") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)
  ) {
    throw new Error("رابط الصورة غير مسموح به. استخدم رابط HTTPS عام.");
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok || !response.body) {
    throw new Error("تعذر تحميل الصورة من المصدر.");
  }

  const type = (
    response.headers.get("content-type") || ""
  ).split(";")[0].trim().toLowerCase();

  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) {
    throw new Error("الرابط لا يشير إلى صورة JPEG أو PNG أو WebP.");
  }

  const contentLength = Number(
    response.headers.get("content-length") || 0,
  );

  if (contentLength > maxBytes) {
    throw new Error("حجم الصورة أكبر من الحد المسموح.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.length;

    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("حجم الصورة أكبر من الحد المسموح.");
    }

    chunks.push(value);
  }

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    blob: new Blob([buffer], { type }),
    type,
  };
}

function extensionFor(type: string) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "jpg";
}

function getImageUrl(images?: ImageSet): string | undefined {
  return (
    images?.webp?.large_image_url ||
    images?.webp?.image_url ||
    images?.jpg?.large_image_url ||
    images?.jpg?.image_url
  );
}

function searchUrl(query: string, limit: number) {
  return new URLSearchParams({
    q: query,
    limit: String(limit),
    "sfw-strict": "true",
  }).toString();
}

function formatTenraiError(error: unknown): string {
  if (error instanceof TenraiApiError) {
    return [
      "Tenrai request failed",
      `HTTP status: ${error.status}`,
      `Endpoint path: ${error.endpoint}`,
      `Retry-After: ${error.retryAfter ?? "not provided"}`,
      `Rate-limit headers: ${JSON.stringify(error.rateLimitHeaders)}`,
      `Message: ${error.message}`,
      `Response body (first 700 chars): ${error.responseBody || "(empty)"}`,
    ].join("\n");
  }

  return String(error);
}

function createServer() {
  const server = new McpServer({
    name: "Anime Elara Publisher",
    version: "2.3.1",
  });

  // TMDB read-only diagnostic.
  // Exactly ONE request. Never publishes to Telegram.
  server.registerTool(
    "diagnose_tmdb",
    {
      description:
        "Test TMDB Bearer authentication and search for an anime using exactly one read-only Multi Search request. Reports HTTP status, response time, matching titles, and poster/backdrop availability. Never publishes to Telegram and never reveals credentials.",
      inputSchema: z.object({
        query: z.string().min(2).max(100).default("Frieren"),
      }),
    },
    async ({ query }) => {
      const token = workerEnv.TMDB_READ_TOKEN;

      if (!token) {
        return errorResult(
          "TMDB_READ_TOKEN is missing from Cloudflare Secrets.",
        );
      }

      const params = new URLSearchParams({
        query,
        include_adult: "false",
        language: "en-US",
        page: "1",
      });

      const endpoint = `/search/multi?${params.toString()}`;
      const started = Date.now();

      try {
        const response = await fetch(
          `${TMDB_API}${endpoint}`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(15000),
          },
        );

        const elapsedMs = Date.now() - started;
        const raw = await response.text();

        let payload: {
          results?: {
            id?: number;
            media_type?: string;
            title?: string;
            name?: string;
            original_title?: string;
            original_name?: string;
            poster_path?: string | null;
            backdrop_path?: string | null;
          }[];
          status_message?: string;
        };

        try {
          payload = JSON.parse(raw);
        } catch {
          return errorResult(
            `TMDB returned invalid JSON. HTTP ${response.status}.`,
          );
        }

        if (!response.ok) {
          return errorResult(
            [
              "TMDB diagnostic failed.",
              `HTTP status: ${response.status}`,
              `Elapsed: ${elapsedMs}ms`,
              `Message: ${payload.status_message || "Unknown API error"}`,
              "Credential value was not exposed.",
            ].join("\n"),
          );
        }

        const results = Array.isArray(payload.results)
          ? payload.results
          : [];

        const matches = results
          .filter(
            (item) =>
              item.media_type === "movie" ||
              item.media_type === "tv",
          )
          .slice(0, 5)
          .map((item) => ({
            id: item.id ?? null,
            media_type: item.media_type,
            title:
              item.title ||
              item.name ||
              item.original_title ||
              item.original_name ||
              "Unknown",
            original_title:
              item.original_title ||
              item.original_name ||
              null,
            has_poster: Boolean(item.poster_path),
            has_backdrop: Boolean(item.backdrop_path),
            poster_url: item.poster_path
              ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
              : null,
            backdrop_url: item.backdrop_path
              ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`
              : null,
          }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              service: "TMDB",
              http_status: response.status,
              elapsed_ms: elapsedMs,
              query,
              total_results: results.length,
              matching_titles: matches,
              note:
                "Exactly one read-only request. Images were not downloaded. No Telegram action. Token was not exposed.",
            }, null, 2),
          }],
        };
      } catch (error) {
        return errorResult(
          `TMDB network/timeout error: ${
            error instanceof Error
              ? error.message
              : "Unknown error"
          }. Credential value was not exposed.`,
        );
      }
    },
  );

  // Read-only diagnostic: makes exactly ONE Tenrai request.
  server.registerTool(
    "diagnose_tenrai",
    {
      description:
        "Make exactly one read-only request to Tenrai character search and report HTTP status, response time, Retry-After, and a short safe response summary. Never publishes to Telegram.",
      inputSchema: z.object({
        query: z.string().min(2).max(100).default("Naruto"),
      }),
    },
    async ({ query }) => {
      const path = `/characters?${searchUrl(query, 1)}`;

      try {
        const result = await tenraiRequest<AnimeEntry>(path);
        const first = result.data[0];

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              service: "Tenrai",
              endpoint_path: result.endpointPath,
              http_status: result.status,
              elapsed_ms: result.elapsedMs,
              retry_after: result.retryAfter,
              rate_limit_headers: result.rateLimitHeaders,
              result_count: result.data.length,
              first_result: first
                ? {
                    mal_id: first.mal_id,
                    name: first.name ?? null,
                    has_image: Boolean(getImageUrl(first.images)),
                    source_url: first.url ?? null,
                  }
                : null,
              note:
                "One request only. No images downloaded. No Telegram action.",
            }, null, 2),
          }],
        };
      } catch (error) {
        return errorResult(formatTenraiError(error));
      }
    },
  );

  // Search anime and character images
  server.registerTool(
    "search_anime_images",
    {
      description:
        "Search Tenrai anime database for character images, anime covers, or anime galleries. Returns direct image URLs and source links. Use this tool to find images before publishing. Never publish unless the user explicitly asks.",
      inputSchema: z.object({
        query: z.string().min(2).max(100),
        kind: z.enum([
          "character",
          "anime_cover",
          "anime_gallery",
        ]).default("character"),
        max_results: z.number().int().min(1).max(8).default(6),
      }),
    },
    async ({ query, kind, max_results }) => {
      try {
        const results: {
          name: string;
          image_url: string;
          source_url: string;
          type: string;
        }[] = [];

        const params = searchUrl(query, 5);

        if (kind === "character") {
          const matches = await tenraiGet<AnimeEntry>(
            `/characters?${params}`,
          );

          for (const item of matches) {
            const image = getImageUrl(item.images);

            if (image) {
              results.push({
                name: item.name || "Unknown character",
                image_url: image,
                source_url: item.url || "",
                type: "character portrait",
              });
            }
          }

          // Sequential second request for the best match only.
          if (matches.length > 0) {
            const best = matches[0];

            const pictures = await tenraiGet<PictureEntry>(
              `/characters/${best.mal_id}/pictures`,
            );

            for (const picture of pictures) {
              const image = getImageUrl(picture);

              if (image) {
                results.push({
                  name: best.name || "Character gallery",
                  image_url: image,
                  source_url: best.url || "",
                  type: "character gallery",
                });
              }
            }
          }
        }

        if (kind === "anime_cover") {
          const matches = await tenraiGet<AnimeEntry>(
            `/anime?${params}`,
          );

          for (const item of matches) {
            const image = getImageUrl(item.images);

            if (image) {
              results.push({
                name: item.title || "Unknown anime",
                image_url: image,
                source_url: item.url || "",
                type: "anime cover",
              });
            }
          }
        }

        if (kind === "anime_gallery") {
          const matches = await tenraiGet<AnimeEntry>(
            `/anime?${params}`,
          );

          if (matches.length > 0) {
            const best = matches[0];

            const pictures = await tenraiGet<PictureEntry>(
              `/anime/${best.mal_id}/pictures`,
            );

            for (const picture of pictures) {
              const image = getImageUrl(picture);

              if (image) {
                results.push({
                  name: best.title || "Anime gallery",
                  image_url: image,
                  source_url: best.url || "",
                  type: "anime gallery",
                });
              }
            }

            if (results.length === 0) {
              const cover = getImageUrl(best.images);

              if (cover) {
                results.push({
                  name: best.title || "Anime cover",
                  image_url: cover,
                  source_url: best.url || "",
                  type: "anime cover",
                });
              }
            }
          }
        }

        const unique = [
          ...new Map(
            results.map((item) => [item.image_url, item]),
          ).values(),
        ].slice(0, max_results);

        if (unique.length === 0) {
          return {
            content: [{
              type: "text",
              text: `لم أجد صوراً مناسبة للبحث: ${query}`,
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              kind,
              source: "Tenrai / MyAnimeList",
              results: unique,
            }, null, 2),
          }],
        };
      } catch (error) {
        return errorResult(
          `فشل البحث عن الصور:\n${formatTenraiError(error)}`,
        );
      }
    },
  );

  // Publish text
  server.registerTool(
    "publish_text",
    {
      description:
        "Publish a text-only post to @anime_elara. Use ONLY when the user explicitly asks to publish.",
      inputSchema: z.object({
        message: z.string().min(1).max(4096),
      }),
    },
    async ({ message }) => {
      try {
        await telegramJson("sendMessage", {
          chat_id: CHANNEL,
          text: message,
        });

        return {
          content: [{
            type: "text",
            text: `تم نشر النص بنجاح في ${CHANNEL}.`,
          }],
        };
      } catch (error) {
        return errorResult(`فشل نشر النص: ${String(error)}`);
      }
    },
  );

  // Publish one photo + caption
  server.registerTool(
    "publish_photo",
    {
      description:
        "Publish one image with a caption to @anime_elara. Supply a direct public HTTPS image URL. Use ONLY after an explicit user request to publish.",
      inputSchema: z.object({
        image_url: z.string().url().max(2048),
        caption: z.string().max(1024).optional(),
      }),
    },
    async ({ image_url, caption }) => {
      try {
        const image = await downloadImage(
          image_url,
          MAX_PHOTO_SIZE,
        );

        const form = new FormData();
        form.set("chat_id", CHANNEL);
        form.set(
          "photo",
          image.blob,
          `anime-image.${extensionFor(image.type)}`,
        );

        if (caption) {
          form.set("caption", caption);
        }

        await telegramForm("sendPhoto", form);

        return {
          content: [{
            type: "text",
            text: `تم نشر الصورة والوصف بنجاح في ${CHANNEL}.`,
          }],
        };
      } catch (error) {
        return errorResult(`فشل نشر الصورة: ${String(error)}`);
      }
    },
  );

  // Publish photo album
  server.registerTool(
    "publish_album",
    {
      description:
        "Publish an album of 2 to 10 images to @anime_elara. The caption is attached to the first image. Use ONLY after an explicit user request to publish.",
      inputSchema: z.object({
        image_urls: z.array(
          z.string().url().max(2048),
        ).min(2).max(10),
        caption: z.string().max(1024).optional(),
      }),
    },
    async ({ image_urls, caption }) => {
      try {
        const form = new FormData();
        form.set("chat_id", CHANNEL);

        const media: {
          type: string;
          media: string;
          caption?: string;
        }[] = [];

        let totalSize = 0;

        for (let i = 0; i < image_urls.length; i++) {
          const image = await downloadImage(
            image_urls[i],
            MAX_ALBUM_IMAGE_SIZE,
          );

          totalSize += image.blob.size;

          if (totalSize > MAX_ALBUM_TOTAL_SIZE) {
            throw new Error(
              "الحجم الإجمالي للألبوم أكبر من الحد المسموح.",
            );
          }

          const attachmentName = `photo_${i}`;

          form.set(
            attachmentName,
            image.blob,
            `${attachmentName}.${extensionFor(image.type)}`,
          );

          const item: {
            type: string;
            media: string;
            caption?: string;
          } = {
            type: "photo",
            media: `attach://${attachmentName}`,
          };

          if (i === 0 && caption) {
            item.caption = caption;
          }

          media.push(item);
        }

        form.set("media", JSON.stringify(media));
        await telegramForm("sendMediaGroup", form);

        return {
          content: [{
            type: "text",
            text: `تم نشر ألبوم من ${image_urls.length} صور بنجاح في ${CHANNEL}.`,
          }],
        };
      } catch (error) {
        return errorResult(`فشل نشر الألبوم: ${String(error)}`);
      }
    },
  );

  return server;
}

const handler = createMcpHandler(createServer);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const secret = workerEnv.MCP_ACCESS_TOKEN;

    if (
      !secret ||
      !workerEnv.TELEGRAM_BOT_TOKEN
    ) {
      return new Response("Server configuration error", {
        status: 503,
      });
    }

    const url = new URL(request.url);
    const protectedPath = `/s/${secret}/mcp`;

    if (url.pathname !== protectedPath) {
      return new Response("Not found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }

    url.pathname = "/mcp";

    const mcpRequest = new Request(
      url.toString(),
      request,
    );

    return handler(mcpRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;
