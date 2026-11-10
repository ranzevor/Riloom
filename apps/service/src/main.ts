import { startService } from "./index.js";
const index = process.argv.indexOf("--workspace");
if (index < 0 || !process.argv[index + 1])
  throw new Error("A workspace is required");
try {
  const service = await startService({ workspace: process.argv[index + 1]! });
  process.send?.({
    type: "ready",
    workspaceId: service.workspaceId,
    url: service.url,
  });
  const close = () => {
    void service.close().then(() => process.exit(0));
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.on("message", (message) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "shutdown"
    )
      close();
  });
} catch (error) {
  process.send?.({
    type: "error",
    message: error instanceof Error ? error.message : "Service startup failed",
  });
  process.exitCode = 1;
}
