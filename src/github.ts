import { readResponse } from "./http-internal.ts";
import {
  PermissionDenied,
  type Operation,
  type Resource,
  type ResourceId,
} from "./types.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub response");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid GitHub object ID");
  return String(value);
}

function route(owner: string, repository: string, issue: string): string {
  if (
    !/^[A-Za-z0-9-]{1,100}$/.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
    repository === "." ||
    repository === ".." ||
    !/^[1-9][0-9]{0,14}$/.test(issue)
  )
    throw new Error("Invalid GitHub target");
  return `/repos/${owner}/${repository}`;
}

export function createGitHubConnector(options: {
  connectionId: string;
  token?: string;
  fetch?: typeof fetch;
}) {
  if (!options.connectionId || options.connectionId.length > 128)
    throw new Error("Invalid connection ID");
  const connection = options.connectionId;
  const token = options.token;
  const request = options.fetch ?? fetch;
  async function get(path: string) {
    const response = await request(`https://api.github.com${path}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        "user-agent": "capvine-read-connector",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub read returned HTTP ${response.status}`);
    }
    return record(await readResponse(response));
  }
  async function read(target: Record<string, string>) {
    if (
      Object.keys(target).sort().join(",") !==
        "connection,issueId,number,owner,repository,repositoryId" ||
      target.connection !== connection
    )
      throw new PermissionDenied("Unknown GitHub binding");
    const base = route(target.owner!, target.repository!, target.number!);
    const repository = await get(base);
    if (id(repository.id) !== target.repositoryId)
      throw new PermissionDenied("GitHub repository identity changed");
    const issue = await get(`${base}/issues/${target.number}`);
    if (
      id(issue.id) !== target.issueId ||
      id(issue.number) !== target.number ||
      issue.repository_url !== `https://api.github.com${base}` ||
      Object.hasOwn(issue, "pull_request")
    )
      throw new PermissionDenied("GitHub issue identity changed");
    if (
      typeof issue.title !== "string" ||
      (issue.body !== null && typeof issue.body !== "string") ||
      !["open", "closed"].includes(String(issue.state))
    )
      throw new Error("Invalid GitHub issue response");
    return {
      id: target.issueId!,
      repositoryId: target.repositoryId!,
      number: target.number!,
      title: issue.title,
      body: issue.body as string | null,
      state: String(issue.state),
    };
  }
  const operation: Operation = {
    action: "github/issue.read",
    resourceKind: "github.issue",
    execute: async (resource) => {
      if (resource.kind !== "github.issue")
        throw new PermissionDenied("Wrong resource kind");
      return read(resource.target);
    },
  };
  return {
    operation,
    async resolveIssue(input: {
      id: ResourceId;
      ownerId: string;
      owner: string;
      repository: string;
      number: number;
    }): Promise<Resource> {
      const number = id(input.number);
      const base = route(input.owner, input.repository, number);
      const repository = await get(base);
      const issue = await get(`${base}/issues/${number}`);
      if (
        id(issue.number) !== number ||
        issue.repository_url !== `https://api.github.com${base}` ||
        Object.hasOwn(issue, "pull_request")
      )
        throw new Error("Expected a GitHub issue in the selected repository");
      return {
        id: input.id,
        ownerId: input.ownerId,
        kind: "github.issue",
        target: {
          connection,
          owner: input.owner,
          repository: input.repository,
          repositoryId: id(repository.id),
          number,
          issueId: id(issue.id),
        },
      };
    },
  };
}
