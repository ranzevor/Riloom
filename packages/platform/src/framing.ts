import { EventEmitter } from "node:events";
import type { Wire } from "./pipes.js";

export const maxFrameBytes = 24 * 1024 * 1024;
export class FramedConnection extends EventEmitter {
  private pending = Buffer.alloc(0);
  constructor(readonly wire: Wire) {
    super();
    wire.on("data", (chunk: Buffer) => this.receive(chunk));
    wire.on("close", () => this.emit("close"));
  }
  private receive(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (!length || length > maxFrameBytes) {
        this.close();
        return;
      }
      if (this.pending.length < length + 4) return;
      const body = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      try {
        this.emit(
          "message",
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
        );
      } catch {
        this.close();
        return;
      }
    }
  }
  send(value: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify(value));
    if (!body.length || body.length > maxFrameBytes)
      return Promise.reject(new Error("Frame exceeds limit"));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    return this.wire.send(Buffer.concat([prefix, body]));
  }
  close(): void {
    this.wire.close();
  }
}
