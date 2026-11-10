import { Application } from "../../packages/application/dist/index.js";
import { SQLiteWorkspace } from "../../packages/storage/dist/index.js";
const [directory, lockDirectory, point, input] = process.argv.slice(2);
const store = new SQLiteWorkspace(directory, {
  lockDirectory,
  checkpoint(current) {
    if (current === point) {
      process.stdout.write("checkpoint:" + point + "\n");
      process.kill(process.pid, "SIGKILL");
    }
  },
});
const app = new Application(store, "crash-generation", "crash-secret");
if (input) {
  app.execute(JSON.parse(input));
} else
  app.execute({
    requestId: "crash-create",
    command: "riloom.project.create",
    commandVersion: "1.0.0",
    workspaceId: store.workspaceId,
    arguments: {
      name: "中断工程",
      directory: "crash.riloom",
      canvas: { width: 100, height: 100 },
    },
  });
store.close();
