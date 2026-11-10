import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  commands,
  requestSchema,
  isCommandName,
  RiloomError,
} from "@riloom/contracts";
import type { RiloomClient } from "@riloom/sdk";

export async function runMcp(client: RiloomClient): Promise<Server> {
  const server = new Server(
    { name: "Riloom", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(commands).map(([name, command]) => {
      const schema = requestSchema(name as keyof typeof commands);
      const properties = Object.fromEntries(
        Object.entries(schema.properties).filter(([key]) => key !== "command"),
      );
      return {
        name,
        description: command.description,
        inputSchema: {
          ...schema,
          properties,
          required: schema.required.filter((key) => key !== "command"),
        },
        annotations: {
          readOnlyHint: command.kind === "query",
          destructiveHint:
            command.kind === "apply" || name === "riloom.project.restore",
          idempotentHint: true,
          openWorldHint: false,
        },
      };
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (!isCommandName(request.params.name))
        throw new RiloomError("UNSUPPORTED_FEATURE", "该工具当前不可用");
      const args = request.params.arguments ?? {};
      if (args.command && args.command !== request.params.name)
        throw new RiloomError("INVALID_INPUT", "工具名称与命令不一致");
      const result = await client.execute({
        ...args,
        command: request.params.name,
      } as Parameters<RiloomClient["execute"]>[0]);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: result.status === "failed",
      };
    } catch (error) {
      const result =
        error instanceof RiloomError
          ? {
              error: {
                code: error.code,
                message: error.message,
                details: error.details,
              },
            }
          : { error: { code: "INTERNAL_ERROR", message: "工具调用失败" } };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: true,
      };
    }
  });
  server.onclose = () => client.close();
  await server.connect(new StdioServerTransport());
  return server;
}
