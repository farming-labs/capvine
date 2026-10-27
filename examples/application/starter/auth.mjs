import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { betterAuth } from "better-auth";

export function openAuth({ directory, baseURL, secret, bootstrap = false }) {
  const database = new DatabaseSync(join(directory, "auth.db"));
  const auth = betterAuth({
    database,
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !bootstrap,
      autoSignIn: false,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      defaultCookieAttributes: { sameSite: "strict" },
      ipAddress: { ipAddressHeaders: ["x-starter-client-ip"] },
      database: { validateSchema: !bootstrap },
    },
  });
  return { auth, close: () => database.close() };
}
