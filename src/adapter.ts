import type { Operation, Resource } from "./types.ts";
import { startService } from "./service.ts";

export interface ResourceAdapter {
  resources: Resource[];
  operations: Operation[];
  close(): Promise<void>;
}

export async function startResourceServer(options: {
  directory: string;
  owner: string;
  adapters: ResourceAdapter[];
  port?: number;
  administrationPort?: number;
}) {
  const adapters = [...options.adapters];
  const release = async () => {
    const results = await Promise.allSettled(
      adapters.map((adapter) => adapter.close()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Adapter cleanup failed");
  };
  try {
    const service = await startService({
      directory: options.directory,
      owner: options.owner,
      resources: adapters.flatMap((adapter) => adapter.resources),
      operations: adapters.flatMap((adapter) => adapter.operations),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.administrationPort === undefined
        ? {}
        : { administrationPort: options.administrationPort }),
    });
    let closing: Promise<void> | undefined;
    return {
      ...service,
      close: () =>
        (closing ??= (async () => {
          await service.close();
          await release();
        })()),
    };
  } catch (error) {
    await release();
    throw error;
  }
}
