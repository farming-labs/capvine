import { fork } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";

export async function startWorker(path) {
  const child = fork(new URL("worker.mjs", import.meta.url), [path], {
    cwd: dirname(path),
    env: { NODE_ENV: "production" },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const pending = new Map();
  let sequence = 0;
  const rejectPending = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Worker unavailable"));
    }
    pending.clear();
  };
  child.on("exit", rejectPending);
  child.on("error", rejectPending);
  child.on("message", (message) => {
    const waiter = pending.get(message.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message.result);
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Worker startup timed out"));
    }, 10_000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("Worker startup failed"));
    };
    child.once("exit", fail);
    child.once("error", fail);
    child.once("message", (message) => {
      clearTimeout(timer);
      child.off("exit", fail);
      child.off("error", fail);
      if (message.ready) resolve(message);
      else {
        child.kill();
        reject(new Error("Invalid worker startup"));
      }
    });
  });
  return {
    info: ready,
    request(method, resource) {
      if (!child.connected)
        return Promise.reject(new Error("Worker unavailable"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Worker request timed out"));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, method, resource }, (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
