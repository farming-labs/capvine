type Binding = { accountId: string; subject: string; messageId: string };
type Account = { id: string; fields: { access_token: string } };

export async function inspectAccount(account: Account, request: typeof fetch) {
  const response = await request(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { authorization: `Bearer ${account.fields.access_token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const value = await readJson(response);
  if (
    typeof value?.sub !== "string" ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(value.sub)
  )
    throw new Error("Invalid provider identity");
  return { accountId: account.id, subject: value.sub };
}

async function readJson(response: Response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Provider read failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 131_072) throw new Error("Provider response too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function readBoundMessage(
  account: Account,
  input: Binding,
  request: typeof fetch,
  endpoints = {
    identity: "https://openidconnect.googleapis.com/v1/userinfo",
    messages: "https://gmail.googleapis.com/gmail/v1/users/me/messages/",
  },
) {
  if (
    account.id !== input.accountId ||
    !/^[a-fA-F0-9]{1,128}$/.test(input.messageId)
  )
    throw new Error("Account or message binding denied");
  const headers = { authorization: `Bearer ${account.fields.access_token}` };
  async function get(url: string) {
    const response = await request(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return readJson(response);
  }
  const identity = await get(endpoints.identity);
  if (identity?.sub !== input.subject)
    throw new Error("Provider identity changed");
  const result = await get(
    `${endpoints.messages}${input.messageId}?format=metadata&metadataHeaders=Subject`,
  );
  if (
    result?.id !== input.messageId ||
    typeof result.snippet !== "string" ||
    !Array.isArray(result.payload?.headers)
  )
    throw new Error("Provider message mismatch");
  const subject =
    result.payload.headers.find(
      (header: { name?: string }) => header.name?.toLowerCase() === "subject",
    )?.value ?? "";
  if (
    typeof subject !== "string" ||
    subject.length > 8192 ||
    result.snippet.length > 16_384
  )
    throw new Error("Invalid message projection");
  return {
    protocol: "capvine.gmail.read.v1",
    ...input,
    message: { id: input.messageId, subject, snippet: result.snippet },
  };
}
