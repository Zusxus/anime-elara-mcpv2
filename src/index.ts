
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

function createServer() {
	const server = new McpServer({
		name: "Anime Elara Publisher",
		version: "1.0.0",
	});

	server.registerTool(
		"publish_to_telegram",
		{
			description:
				"Publish a text post to the Telegram channel @anime_elara. Use only when the user explicitly asks to publish.",
			inputSchema: z.object({
				message: z.string().min(1).max(4000),
			}),
		},
		async ({ message }) => {
			try {
				const response = await fetch(
					`https://api.telegram.org/bot${workerEnv.TELEGRAM_BOT_TOKEN}/sendMessage`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							chat_id: "@anime_elara",
							text: message,
						}),
					},
				);

				const result = (await response.json()) as {
					ok?: boolean;
					result?: {
						message_id?: number;
					};
				};

				if (!response.ok || !result.ok) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Telegram rejected the post. HTTP status: ${response.status}`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `تم نشر المنشور بنجاح في @anime_elara. رقم المنشور: ${result.result?.message_id ?? "غير متاح"}`,
						},
					],
				};
			} catch {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "تعذر الاتصال بـ Telegram. لم يتم تأكيد النشر.",
						},
					],
				};
			}
		},
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const authorization = request.headers.get("Authorization");

		if (
			!env.MCP_ACCESS_TOKEN ||
			authorization !== `Bearer ${env.MCP_ACCESS_TOKEN}`
		) {
			return new Response("Unauthorized", {
				status: 401,
				headers: {
					"Cache-Control": "no-store",
				},
			});
		}

		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
