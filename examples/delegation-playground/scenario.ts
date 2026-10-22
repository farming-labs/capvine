import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGrant, type Json } from "../../src/index.ts";
import { Peer } from "../network/ipc.ts";

export const actions = [
  "approve",
  "delegate",
  "read",
  "other-resource",
  "write",
  "other-worker",
  "expired",
  "direct-provider",
  "revoke",
  "end-task",
] as const;
export type Action = (typeof actions)[number];
export class ScenarioError extends Error {}
type Stats = {
  providerReads: string[];
  unauthorizedProviderCalls: number;
  audit: string[];
};
type Result = { status: "allowed" | "denied"; value?: Json };
type GrantView = { id: string; expiresAt: string };
export type Event = {
  sequence: number;
  action: string;
  outcome: string;
  detail: string;
  expected: boolean;
  providerDelta: number;
  authorization: string[];
  result: Json;
};
export type State = {
  coordinator: { did: string; pid: number };
  worker: { did: string; pid: number };
  otherWorker: { did: string; pid: number };
  authorityPid: number;
  root: GrantView | null;
  child: GrantView | null;
  revoked: boolean;
  taskActive: boolean;
  providerReads: number;
  unauthorizedProviderCalls: number;
  events: Event[];
};

export async function startScenario() {
  const directory = await mkdtemp(join(tmpdir(), "capvine-playground-"));
  const peers: Peer[] = [];
  const start = (entry: string, env: Record<string, string> = {}) => {
    const peer = new Peer(new URL(entry, import.meta.url), env);
    peers.push(peer);
    return peer;
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await Promise.all(peers.map((peer) => peer.close()));
      await rm(directory, { recursive: true, force: true });
    })());
  try {
    const authority = start("../network/authority.ts", {
      CAPVINE_DEMO_DB: join(directory, "state.db"),
    });
    const coordinator = start("../network/worker.ts");
    const worker = start("../network/worker.ts");
    const otherWorker = start("../network/worker.ts");
    const info = await authority.request<{
      url: string;
      service: string;
      providerUrl: string;
      pid: number;
    }>("info");
    const identities = await Promise.all(
      [coordinator, worker, otherWorker].map((peer) =>
        peer.request<{ did: string; pid: number }>("info"),
      ),
    );
    await Promise.all(
      [coordinator, worker, otherWorker].map((peer) =>
        peer.request("connect", { url: info.url, service: info.service }),
      ),
    );
    const state: State = {
      coordinator: { did: identities[0]!.did, pid: identities[0]!.pid },
      worker: { did: identities[1]!.did, pid: identities[1]!.pid },
      otherWorker: { did: identities[2]!.did, pid: identities[2]!.pid },
      authorityPid: info.pid,
      root: null,
      child: null,
      revoked: false,
      taskActive: true,
      providerReads: 0,
      unauthorizedProviderCalls: 0,
      events: [],
    };
    let parent: { grant: string; grantId: string } | undefined;
    let child: string | undefined;
    let busy = false;
    async function view(encoded: string): Promise<GrantView> {
      const grant = await decodeGrant(Buffer.from(encoded, "base64"));
      return {
        id: grant.cid.toString(),
        expiresAt: new Date(grant.expiration * 1000).toISOString(),
      };
    }
    const readStats = () => authority.request<Stats>("stats");
    return {
      state: () => structuredClone(state),
      close,
      async run(action: Action) {
        if (closing || busy)
          throw new ScenarioError("The playground is busy or closed");
        if (state.events.length >= 100)
          throw new ScenarioError("Reset the playground after 100 actions");
        busy = true;
        try {
          const before = await readStats();
          let outcome = "done";
          let detail = "";
          let expected = true;
          let result: Json = null;
          if (action === "approve") {
            if (parent || !state.taskActive)
              throw new ScenarioError(
                "Reset before creating another root grant",
              );
            parent = await authority.request<{
              grant: string;
              grantId: string;
            }>("issue", { issue: 42, audience: state.coordinator.did });
            state.root = await view(parent.grant);
            outcome = "granted";
            detail =
              "The owner granted the coordinator read access to issue 42 for ten minutes. No data was read.";
          } else if (action === "delegate") {
            if (!parent || child || state.revoked || !state.taskActive)
              throw new ScenarioError(
                "Approve an active root grant before delegating",
              );
            const delegated = await coordinator.request<{ grant: string }>(
              "delegate",
              { grant: parent.grant, audience: state.worker.did },
            );
            child = delegated.grant;
            state.child = await view(child);
            outcome = "delegated";
            detail =
              "The coordinator signed a child grant for Worker A, for the same issue and read operation, lasting at most five minutes.";
          } else if (action === "revoke") {
            if (!parent || state.revoked)
              throw new ScenarioError(
                "Approve a root grant before revoking it",
              );
            await authority.request("revoke", { grantId: parent.grantId });
            state.revoked = true;
            outcome = "revoked";
            detail =
              "The parent is revoked. Try reading again: its child grant must now fail.";
          } else if (action === "end-task") {
            if (!state.taskActive)
              throw new ScenarioError("The task already ended");
            await authority.request("end-task");
            state.taskActive = false;
            outcome = "ended";
            detail =
              "The task ended. All grants for this task must now fail, including child grants.";
          } else if (action === "direct-provider") {
            const response = await worker.request<{ status: number }>(
              "direct-provider",
              { url: `${info.providerUrl}/issues/42` },
            );
            expected = response.status === 401;
            outcome = expected ? "denied" : "unexpected";
            detail = `The worker called the simulated provider directly and received HTTP ${response.status}. It has no provider credential.`;
          } else {
            if (!child)
              throw new ScenarioError(
                "Delegate to Worker A before trying this request",
              );
            const overrides: Record<string, Json> = { grant: child };
            let caller = worker;
            let method = "attempt";
            switch (action) {
              case "read":
                method = "read";
                detail = "Worker A requested the assigned issue 42.";
                break;
              case "other-resource":
                overrides.resource = "urn:capvine:resource:issue-43";
                detail =
                  "Worker A signed a request for issue 43 using a proof that only permits issue 42.";
                break;
              case "write":
                overrides.action = "github/comment.post";
                detail =
                  "Worker A signed a write request using a read-only proof.";
                break;
              case "other-worker":
                caller = otherWorker;
                detail =
                  "Worker B signed a request using a grant issued to Worker A.";
                break;
              case "expired":
                overrides.expiration = Math.floor(Date.now() / 1000) - 60;
                detail =
                  "Worker A signed an invocation whose expiry is already in the past.";
                break;
            }
            const response = await caller.request<Result>(method, overrides);
            outcome = response.status;
            result = response.value ?? null;
            const permitted =
              action === "read" &&
              !state.revoked &&
              state.taskActive &&
              Date.parse(state.child!.expiresAt) > Date.now();
            expected = response.status === (permitted ? "allowed" : "denied");
          }
          const after = await readStats();
          const providerDelta =
            after.providerReads.length - before.providerReads.length;
          const authorization = after.audit.slice(before.audit.length);
          if (outcome === "denied" && providerDelta !== 0) expected = false;
          if (outcome === "allowed" && providerDelta !== 1) expected = false;
          if (
            (outcome === "allowed" || outcome === "denied") &&
            action !== "direct-provider" &&
            (authorization.length !== 1 || authorization[0] !== outcome)
          )
            expected = false;
          state.providerReads = after.providerReads.length;
          state.unauthorizedProviderCalls = after.unauthorizedProviderCalls;
          state.events.push({
            sequence: state.events.length + 1,
            action,
            outcome,
            detail,
            expected,
            providerDelta,
            authorization,
            result,
          });
          return structuredClone(state);
        } finally {
          busy = false;
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
