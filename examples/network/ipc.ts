import { fork, type ChildProcess } from "node:child_process";
import type { Json } from "../../src/index.ts";

interface Request {
  id: string;
  method: string;
  params: Record<string, Json>;
}
type Reply =
  | { ready: true }
  | { id: string; value: Json }
  | { id: string; error: string };

export function serveIpc(
  handler: (request: Request) => Promise<Json>,
  shutdown: () => Promise<void>,
) {
  process.on("message", (message: Request) => {
    void handler(message).then(
      (value) => process.send?.({ id: message.id, value }),
      (error: unknown) =>
        process.send?.({
          id: message.id,
          error: error instanceof Error ? error.message : "Child failed",
        }),
    );
  });
  process.on("disconnect", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.send?.({ ready: true });
}

export class Peer {
  #child: ChildProcess;
  #pending = new Map<
    string,
    {
      resolve: (value: Json) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #exited = false;
  #stderr = "";
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #readyTimer: NodeJS.Timeout;

  constructor(entry: URL, env: Record<string, string> = {}) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.#ready.catch(() => {});
    this.#readyTimer = setTimeout(
      () => this.#fail(new Error("Child startup timed out")),
      15_000,
    );
    this.#child = fork(entry, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-8_192);
    });
    this.#child.on("message", (message: Reply) => {
      if ("ready" in message) {
        clearTimeout(this.#readyTimer);
        this.#resolveReady();
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if ("error" in message) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    });
    this.#child.on("error", (error) => this.#fail(error));
    this.#child.on("exit", (code, signal) => {
      this.#exited = true;
      this.#fail(
        new Error(`Child exited (${code ?? signal}): ${this.#stderr}`),
      );
    });
  }

  #fail(error: Error): void {
    clearTimeout(this.#readyTimer);
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async request<T extends Json = Json>(
    method: string,
    params: Record<string, Json> = {},
  ): Promise<T> {
    await this.#ready;
    if (this.#exited || !this.#child.connected)
      throw new Error("Child is unavailable");
    const id = crypto.randomUUID();
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Child request timed out: ${method}`));
      }, 15_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.send({ id, method, params } satisfies Request, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(error);
        }
      });
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    if (this.#exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.#child.connected) this.#child.disconnect();
      else this.#child.kill("SIGTERM");
    });
  }
}
