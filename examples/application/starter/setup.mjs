import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { getMigrations } from "better-auth/db/migration";
import {
  initializeIdentity,
  writePrivateFile,
} from "@farming-labs/capvine/identity-file";
import { openAuth } from "./auth.mjs";
import { dataDirectory, localOrigin } from "./state.mjs";

export async function initialize({ directory, baseURL, email, password }) {
  process.umask(0o077);
  baseURL = localOrigin(baseURL);
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    throw new Error("Use a password of 12–128 characters");
  await mkdir(directory, { mode: 0o700 });
  const secret = randomBytes(32).toString("base64url");
  await writePrivateFile(join(directory, "auth-secret"), secret);
  const login = openAuth({ directory, baseURL, secret, bootstrap: true });
  try {
    const { runMigrations } = await getMigrations(login.auth.options);
    await runMigrations();
    const result = await login.auth.api.signUpEmail({
      body: { name: "Owner", email, password },
    });
    await initializeIdentity(join(directory, "coordinator.key"));
    await mkdir(join(directory, "workers"), { mode: 0o700 });
    await mkdir(join(directory, "reports"), { mode: 0o700 });
    await writePrivateFile(
      join(directory, "reports", "daily.txt"),
      "Daily report: 12 requests completed.\n",
    );
    await writePrivateFile(
      join(directory, "reports", "weekly.txt"),
      "Weekly report: 84 requests completed.\n",
    );
    await writePrivateFile(
      join(directory, "settings.json"),
      JSON.stringify({ baseURL, ownerId: result.user.id }),
    );
  } finally {
    login.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.stdin.isTTY)
    throw new Error("Run setup in an interactive terminal");
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    const email = await prompt.question(
      "Owner email (used only for local login): ",
    );
    process.stdout.write("Password (12+ characters, hidden): ");
    hidden = true;
    const password = await prompt.question("");
    process.stdout.write("\nConfirm password: ");
    const confirmation = await prompt.question("");
    hidden = false;
    process.stdout.write("\n");
    if (password !== confirmation) throw new Error("Passwords do not match");
    await initialize({
      directory: dataDirectory(),
      baseURL: process.env.CAPVINE_STARTER_URL ?? "http://127.0.0.1:8800",
      email,
      password,
    });
    console.log(
      "Owner created. Run npm start, then sign in with the password you chose.",
    );
  } finally {
    prompt.close();
  }
}
