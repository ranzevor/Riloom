import net from "node:net";
import { EventEmitter } from "node:events";
import { chmodSync } from "node:fs";
import koffi from "koffi";
import { RiloomError } from "@riloom/contracts";

type NativeFunction = ((...args: unknown[]) => unknown) & {
  async: (...args: unknown[]) => void;
};
type NativePointer = unknown;
export interface Wire extends EventEmitter {
  peerPid: number;
  peerUser: string;
  send(data: Buffer): Promise<void>;
  close(): void;
}
export interface PipeServer {
  close(): void | Promise<void>;
}
const denied = () =>
  new RiloomError("PERMISSION_DENIED", "本地连接身份校验失败");
let windowsApi: ReturnType<typeof loadWindows> | undefined;
function loadWindows() {
  const kernel = koffi.load("kernel32.dll");
  const advapi = koffi.load("advapi32.dll");
  const fn = (lib: typeof kernel, declaration: string) =>
    lib.func(declaration) as NativeFunction;
  const close = fn(kernel, "int __stdcall CloseHandle(void *handle)");
  const free = fn(kernel, "void * __stdcall LocalFree(void *handle)");
  const attributes = koffi.struct("RILOOM_SECURITY_ATTRIBUTES", {
    length: "uint32_t",
    descriptor: "void *",
    inherit: "int",
  });
  const lastError = fn(kernel, "uint32_t __stdcall GetLastError()");
  const create = fn(
    kernel,
    "void * __stdcall CreateNamedPipeW(str16 name, uint32_t openMode, uint32_t mode, uint32_t instances, uint32_t outSize, uint32_t inSize, uint32_t timeout, RILOOM_SECURITY_ATTRIBUTES *attributes)",
  );
  const connect = fn(
    kernel,
    "int __stdcall ConnectNamedPipe(void *handle, void *overlapped)",
  );
  const open = fn(
    kernel,
    "void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *templateFile)",
  );
  const read = fn(
    kernel,
    "int __stdcall ReadFile(void *handle, _Out_ void *buffer, uint32_t count, _Out_ uint32_t *readCount, void *overlapped)",
  );
  const write = fn(
    kernel,
    "int __stdcall WriteFile(void *handle, void *buffer, uint32_t count, _Out_ uint32_t *written, void *overlapped)",
  );
  const setMode = fn(
    kernel,
    "int __stdcall SetNamedPipeHandleState(void *handle, uint32_t *mode, void *collectionCount, void *timeout)",
  );
  const cancel = fn(
    kernel,
    "int __stdcall CancelIoEx(void *handle, void *overlapped)",
  );
  const clientPid = fn(
    kernel,
    "int __stdcall GetNamedPipeClientProcessId(void *handle, _Out_ uint32_t *pid)",
  );
  const serverPid = fn(
    kernel,
    "int __stdcall GetNamedPipeServerProcessId(void *handle, _Out_ uint32_t *pid)",
  );
  const openProcess = fn(
    kernel,
    "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
  );
  const openToken = fn(
    advapi,
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  );
  const tokenInfo = fn(
    advapi,
    "int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t length, _Out_ uint32_t *needed)",
  );
  const sidString = fn(
    advapi,
    "int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
  );
  const descriptor = fn(
    advapi,
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t version, _Out_ void **descriptor, void *size)",
  );
  const getDacl = fn(
    advapi,
    "int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)",
  );
  const setSecurity = fn(
    advapi,
    "uint32_t __stdcall SetNamedSecurityInfoW(str16 name, int kind, uint32_t info, void *owner, void *group, void *dacl, void *sacl)",
  );
  const invalid = (pointer: NativePointer) =>
    !pointer || koffi.address(pointer) === 0xffffffffffffffffn;
  function userOf(pid: number): string {
    const processHandle = openProcess(0x1000, 0, pid);
    if (invalid(processHandle)) throw denied();
    const token: NativePointer[] = [null];
    try {
      if (!openToken(processHandle, 8, token)) throw denied();
      const needed = [0];
      tokenInfo(token[0], 1, null, 0, needed);
      if (!needed[0]) throw denied();
      const buffer = Buffer.alloc(needed[0]);
      if (!tokenInfo(token[0], 1, buffer, buffer.length, needed))
        throw denied();
      const text: NativePointer[] = [null];
      if (!sidString(koffi.decode(buffer, "void *"), text)) throw denied();
      try {
        return koffi.decode.string16(text[0]);
      } finally {
        free(text[0]);
      }
    } finally {
      if (token[0]) close(token[0]);
      close(processHandle);
    }
  }
  const currentUser = userOf(process.pid);
  function security(inherit: boolean): NativePointer {
    const result: NativePointer[] = [null];
    const flags = inherit ? "OICI" : "";
    if (
      !descriptor(
        "D:P(A;" +
          flags +
          ";GA;;;" +
          currentUser +
          ")(A;" +
          flags +
          ";GA;;;SY)",
        1,
        result,
        null,
      )
    )
      throw denied();
    return result[0];
  }
  function protect(filename: string): void {
    const sd = security(true);
    try {
      const acl: NativePointer[] = [null],
        present = [0],
        defaulted = [0];
      if (
        !getDacl(sd, present, acl, defaulted) ||
        setSecurity(filename, 1, 0x80000004, null, null, acl[0], null) !== 0
      )
        throw denied();
    } finally {
      free(sd);
    }
  }
  function peer(handle: NativePointer, server: boolean) {
    const pid = [0];
    if (!(server ? clientPid(handle, pid) : serverPid(handle, pid)) || !pid[0])
      throw denied();
    const user = userOf(pid[0]);
    if (user !== currentUser) throw denied();
    return { pid: pid[0], user };
  }
  return {
    close,
    free,
    create,
    connect,
    open,
    read,
    write,
    cancel,
    attributes,
    lastError,
    setMode,
    invalid,
    security,
    protect,
    peer,
  };
}
function win() {
  return (windowsApi ??= loadWindows());
}
export function protectPrivatePath(filename: string): void {
  if (process.platform === "win32") win().protect(filename);
  else chmodSync(filename, 0o700);
}
class WindowsWire extends EventEmitter implements Wire {
  readonly peerPid: number;
  readonly peerUser: string;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly handle: NativePointer,
    server: boolean,
  ) {
    super();
    if (!win().setMode(handle, [1], null, null)) throw denied();
    const peer = win().peer(handle, server);
    this.peerPid = peer.pid;
    this.peerUser = peer.user;
    this.timer = setTimeout(() => this.readNext(), 0);
  }
  private readNext(): void {
    if (this.closed) return;
    const data = Buffer.alloc(65536),
      count = [0];
    const result = win().read(this.handle, data, data.length, count, null);
    if (result && count[0]) this.emit("data", data.subarray(0, count[0]));
    else if (!result && win().lastError() !== 232) {
      this.close();
      return;
    }
    this.timer = setTimeout(() => this.readNext(), count[0] ? 0 : 5);
  }
  send(data: Buffer): Promise<void> {
    const run = async () => {
      let offset = 0;
      const deadline = Date.now() + 30000;
      while (offset < data.length) {
        if (this.closed || Date.now() > deadline)
          throw new RiloomError("RESOURCE_BUSY", "本地连接写入超时");
        const written = [0];
        const length = Math.min(65536, data.length - offset);
        if (
          !win().write(
            this.handle,
            data.subarray(offset, offset + length),
            length,
            written,
            null,
          )
        ) {
          this.close();
          throw new RiloomError("RESOURCE_BUSY", "本地连接写入失败");
        }
        offset += written[0]!;
        if (!written[0]) await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    this.writes = this.writes.then(run);
    return this.writes;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    win().close(this.handle);
    this.emit("close");
  }
}
function unixPeer(socket: net.Socket): { pid: number; user: string } {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) throw denied();
  const libc = koffi.load(null);
  if (process.platform === "linux") {
    const credentials = Buffer.alloc(12),
      length = [12];
    const getsockopt = libc.func(
      "int getsockopt(int fd, int level, int option, _Out_ void *value, _Inout_ uint32_t *length)",
    );
    if (getsockopt(fd, 1, 17, credentials, length) !== 0) throw denied();
    const uid = credentials.readUInt32LE(4),
      pid = credentials.readInt32LE(0);
    if (uid !== process.getuid?.()) throw denied();
    return { pid, user: String(uid) };
  }
  if (process.platform === "darwin") {
    const uid = [0],
      gid = [0],
      pid = Buffer.alloc(4),
      length = [4];
    if (
      libc.func(
        "int getpeereid(int fd, _Out_ uint32_t *uid, _Out_ uint32_t *gid)",
      )(fd, uid, gid) !== 0 ||
      libc.func(
        "int getsockopt(int fd, int level, int option, _Out_ void *value, _Inout_ uint32_t *length)",
      )(fd, 0, 2, pid, length) !== 0 ||
      uid[0] !== process.getuid?.()
    )
      throw denied();
    return { pid: pid.readInt32LE(), user: String(uid[0]) };
  }
  throw new RiloomError(
    "UNSUPPORTED_FEATURE",
    "当前平台未提供本地对端身份校验",
  );
}
class UnixWire extends EventEmitter implements Wire {
  readonly peerPid: number;
  readonly peerUser: string;
  constructor(private readonly socket: net.Socket) {
    super();
    const peer = unixPeer(socket);
    this.peerPid = peer.pid;
    this.peerUser = peer.user;
    socket.on("data", (data) => this.emit("data", data));
    socket.on("close", () => this.emit("close"));
    socket.on("error", () => this.close());
  }
  send(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) =>
      this.socket.write(data, (error) => (error ? reject(error) : resolve())),
    );
  }
  close(): void {
    this.socket.destroy();
  }
}
export async function listenPipe(
  endpoint: string,
  accept: (wire: Wire) => void,
): Promise<PipeServer> {
  if (process.platform !== "win32") {
    const server = net.createServer((socket) => {
      try {
        accept(new UnixWire(socket));
      } catch {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    chmodSync(endpoint, 0o600);
    return {
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  }
  const api = win(),
    handles = new Set<NativePointer>();
  let closed = false,
    first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    if (closed) return;
    const sd = api.security(false);
    let handle: NativePointer;
    try {
      handle = api.create(
        endpoint,
        3 | (first ? 0x80000 : 0),
        9,
        32,
        65536,
        65536,
        0,
        { length: api.attributes.size, descriptor: sd, inherit: 0 },
      );
    } finally {
      api.free(sd);
    }
    if (api.invalid(handle))
      throw new RiloomError("RESOURCE_BUSY", "本地端点已被占用");
    first = false;
    handles.add(handle);
    const poll = () => {
      if (closed) return;
      const connected = api.connect(handle, null);
      const error = connected ? 0 : api.lastError();
      if (!connected && error === 536) {
        timer = setTimeout(poll, 5);
        return;
      }
      if (!connected && error !== 535) {
        handles.delete(handle);
        api.close(handle);
        timer = setTimeout(next, 0);
        return;
      }
      handles.delete(handle);
      try {
        accept(new WindowsWire(handle, true));
      } catch {
        api.close(handle);
      }
      next();
    };
    timer = setTimeout(poll, 0);
  };
  next();
  return {
    close: () => {
      closed = true;
      clearTimeout(timer);
      for (const handle of handles) api.close(handle);
      handles.clear();
    },
  };
}
export async function connectPipe(endpoint: string): Promise<Wire> {
  if (process.platform === "win32") {
    const handle = win().open(endpoint, 0xc0000000, 0, null, 3, 0, null);
    if (win().invalid(handle))
      throw new RiloomError("RESOURCE_BUSY", "无法连接工作区服务");
    try {
      return new WindowsWire(handle, false);
    } catch (error) {
      win().close(handle);
      throw error;
    }
  }
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  try {
    return new UnixWire(socket);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
