import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PermissionDenied, type Resource, type ResourceId } from "./types.ts";
import type { ResourceAdapter } from "./adapter.ts";

function safeFile(info: BigIntStats): void {
  if (
    !info.isFile() ||
    info.nlink !== 1n ||
    info.uid !== BigInt(process.getuid!()) ||
    (info.mode & 0o022n) !== 0n
  )
    throw new Error(
      "Expected a service-owned regular file without other writers or hard links",
    );
}

async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error(
      "Expected a service-owned directory without other writers or symbolic links",
    );
}

export async function createFilesystemAdapter(options: {
  root: string;
  connectionId: string;
  ownerId: string;
  files: { id: ResourceId; path: string }[];
  maxBytes?: number;
}): Promise<ResourceAdapter> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Filesystem adapter requires Linux or macOS");
  const maxBytes = options.maxBytes ?? 131_072;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 131_072 ||
    !options.connectionId ||
    !options.ownerId ||
    options.files.length > 256
  )
    throw new Error("Invalid filesystem configuration");
  await safeDirectory(options.root);
  const root = await realpath(options.root);
  const bindings = new Map<string, { file: FileHandle; resource: Resource }>();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled(
      [...bindings.values()].map(({ file }) => file.close()),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("File cleanup failed");
  };
  try {
    for (const input of options.files) {
      const segments = input.path.split("/");
      if (
        !input.id.startsWith("urn:capvine:resource:") ||
        bindings.has(input.id) ||
        segments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            /[\\\0]/.test(segment),
        )
      )
        throw new Error("Invalid or duplicate file binding");
      let parent = root;
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        await safeDirectory(parent);
      }
      const file = await open(
        join(parent, segments.at(-1)!),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat({ bigint: true });
        safeFile(info);
        if (info.size > BigInt(maxBytes))
          throw new Error("File exceeds read limit");
        const resource: Resource = {
          id: input.id,
          ownerId: options.ownerId,
          kind: "fs.file",
          target: {
            connection: options.connectionId,
            root,
            path: input.path,
            device: String(info.dev),
            inode: String(info.ino),
            birth: String(info.birthtimeNs),
          },
        };
        bindings.set(input.id, { file, resource });
      } catch (error) {
        await file.close();
        throw error;
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    resources: structuredClone(
      [...bindings.values()].map(({ resource }) => resource),
    ),
    operations: [
      {
        action: "fs/read",
        resourceKind: "fs.file",
        execute: async (resource) => {
          const binding = bindings.get(resource.id);
          if (
            closed ||
            !binding ||
            !isDeepStrictEqual(binding.resource, resource)
          )
            throw new PermissionDenied("Unknown file binding");
          const before = await binding.file.stat({ bigint: true });
          safeFile(before);
          if (before.size > BigInt(maxBytes))
            throw new Error("File exceeds read limit");
          const buffer = Buffer.alloc(maxBytes + 1);
          let size = 0;
          while (size < buffer.length) {
            const chunk = await binding.file.read(
              buffer,
              size,
              buffer.length - size,
              size,
            );
            if (!chunk.bytesRead) break;
            size += chunk.bytesRead;
          }
          if (size > maxBytes) throw new Error("File exceeds read limit");
          const after = await binding.file.stat({ bigint: true });
          safeFile(after);
          if (
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            before.size !== after.size
          )
            throw new Error("File changed during read");
          return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(buffer.subarray(0, size));
        },
      },
    ],
    close,
  };
}
