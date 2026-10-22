import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { openAccountManager, type AccountManager } from "../src/accounts.ts";
import { startAccountConsole } from "../src/account-console.ts";
import { createGoogleProvider } from "../src/oauth.ts";
import { readPrivateFile, writePrivateFile } from "../src/identity-file.ts";
import { startProviderFixture } from "./accounts/provider-fixture.ts";

const [mode, path, ...extra] = process.argv.slice(2);
let accounts: AccountManager | undefined;
let consoleApp: Awaited<ReturnType<typeof startAccountConsole>> | undefined;
let fixture: Awaited<ReturnType<typeof startProviderFixture>> | undefined;
let temporary: string | undefined;
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= (async () => {
    await consoleApp?.close();
    await accounts?.close();
    await fixture?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  })());
try {
  let port: number;
  let ownerId: string;
  let directory: string;
  let key: Buffer;
  let loginKey: string;
  let loginKeyFile: string;
  let provider;
  if (mode === "--fixture" && !path && !extra.length) {
    port = 8787;
    temporary = await mkdtemp(join(tmpdir(), "capvine-console-"));
    directory = join(temporary, "accounts");
    ownerId = "example-owner";
    key = randomBytes(32);
    loginKey = randomBytes(32).toString("base64url");
    loginKeyFile = join(temporary, "console.key");
    await writePrivateFile(loginKeyFile, loginKey);
    fixture = await startProviderFixture({
      redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
    });
    provider = fixture.provider();
  } else if (mode === "--config" && path && !extra.length) {
    const config = JSON.parse(await readPrivateFile(path, 16_384));
    const fields = [
      "port",
      "ownerId",
      "directory",
      "encryptionKeyFile",
      "loginKeyFile",
      "googleClientIdFile",
      "googleClientSecretFile",
    ];
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      Object.keys(config).some((field) => !fields.includes(field)) ||
      !Number.isSafeInteger(config.port) ||
      config.port < 1024 ||
      config.port > 65535 ||
      typeof config.ownerId !== "string" ||
      !config.ownerId ||
      config.ownerId.length > 256 ||
      fields
        .filter((field) => field !== "port" && field !== "ownerId")
        .some(
          (field) =>
            typeof config[field] !== "string" || !isAbsolute(config[field]),
        )
    )
      throw new Error("Invalid configuration");
    port = config.port;
    ownerId = config.ownerId;
    directory = config.directory;
    const encodedKey = await readPrivateFile(config.encryptionKeyFile);
    if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey))
      throw new Error("Invalid encryption key");
    key = Buffer.from(encodedKey, "base64url");
    loginKeyFile = config.loginKeyFile;
    loginKey = await readPrivateFile(loginKeyFile);
    if (loginKey === encodedKey)
      throw new Error("Separate console and encryption keys are required");
    provider = createGoogleProvider({
      clientId: await readPrivateFile(config.googleClientIdFile),
      clientSecret: await readPrivateFile(config.googleClientSecretFile),
      redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
    });
  } else {
    throw new Error(
      "Usage: npm run console:accounts -- --fixture | --config /absolute/private-config.json",
    );
  }
  accounts = await openAccountManager({
    directory,
    key,
    providers: [provider],
  });
  key.fill(0);
  consoleApp = await startAccountConsole({
    accounts,
    ownerId,
    loginKey,
    port,
    gmail: fixture
      ? { source: "fixture", fetch: fixture.gmailFetch }
      : { source: "google" },
    providers: [
      {
        id: "google",
        label: fixture ? "Google (local test provider)" : "Google / Gmail",
        authorizationOrigin: fixture?.issuer ?? "https://accounts.google.com",
      },
    ],
  });
  console.log(
    JSON.stringify({
      url: consoleApp.url,
      callbackUrl: consoleApp.callbackUrl,
      loginKeyFile,
      mode: fixture
        ? "temporary fixture — no real account"
        : "Google — persistent local accounts",
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    });
} catch {
  console.error(
    "Console startup failed. Use --fixture or --config /absolute/private-config.json; check the port, private file permissions, and provider configuration. See docs/account-console.md.",
  );
  process.exitCode = 1;
  await close();
}
