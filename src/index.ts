
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

declare global {
  interface Env {
    TELEGRAM_BOT_TOKEN: string;
    MCP_ACCESS_TOKEN: string;
  }
}

const CHANNEL = "@anime_elara";
const TELEGRAM_API = `https://api.telegram.org/bot${workerEnv.TELEGRAM_BOT_TOKEN}`;
const MAX_PHOTO_SIZE = 9 * 1024 * 1024;
const MAX_ALBUM_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_ALBUM_TOTAL_SIZE = 25 * 1024 * 1024;

type TelegramResult = {
  ok?: boolean;
  description?: string;
  result?: {
    message_id?: number;
  }[];
};

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

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

async function telegramForm(
  method: string,
  form: FormData,
) {
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

function createServer() {
  const server = new McpServer({
    name: "Anime Elara Publisher",
    version: "2.0.0",
  });

  // 1. Text-only post
  server.registerTool(
    "publish_text",
    {
      description:
        "Publish a text-only post to @anime_elara. Use ONLY when the user explicitly asks to publish. Never publish automatically.",
      inputSchema: z.object({
        message: z.string().min(1).max(4096),
      }),
    },
    async ({ message }) => {
      try {
        const result = await telegramJson("sendMessage", {
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
        return errorResult(
          `فشل نشر النص: ${String(error)}`,
        );
      }
    },
  );

  // 2. Single photo + caption
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

        const result = await telegramForm("sendPhoto", form);

        return {
          content: [{
            type: "text",
            text: `تم نشر الصورة والوصف بنجاح في ${CHANNEL}.`,
          }],
        };
      } catch (error) {
        return errorResult(
          `فشل نشر الصورة: ${String(error)}`,
        );
      }
    },
  );

  // 3. Photo album
  server.registerTool(
    "publish_album",
    {
      description:
        "Publish an album of 2 to 10 images to @anime_elara. Supply direct public HTTPS image URLs. The caption is attached to the first image. Use ONLY after an explicit user request to publish.",
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
        return errorResult(
          `فشل نشر الألبوم: ${String(error)}`,
        );
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

    // Rewrite the protected URL to the normal MCP endpoint.
    url.pathname = "/mcp";

    const mcpRequest = new Request(url.toString(), request);

    return handler(mcpRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;
