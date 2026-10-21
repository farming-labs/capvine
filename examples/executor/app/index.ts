import {
  defineApp,
  defineProvider,
  oauth2,
  object,
  query,
  router,
  string,
  type QueryContext,
} from "apps";
import { never } from "apps/operations/approval";
import { inspectAccount, readBoundMessage } from "./read.ts";

const gmail = defineProvider({
  name: "Capvine Gmail reader",
  auth: {
    google: oauth2({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      authorizationParams: { access_type: "offline", prompt: "consent" },
    }),
  },
});
const requirements = { user: { accounts: { gmail } } };

export default defineApp(requirements, {
  tools: router({
    inspectAccount: query(
      { input: object({}), approval: never() },
      (ctx: QueryContext<typeof requirements>) =>
        inspectAccount(ctx.user.accounts.gmail, ctx.fetch),
    ),
    readMessage: query(
      {
        description:
          "Read the subject and snippet of an account-bound Gmail message.",
        input: object({
          accountId: string(),
          subject: string(),
          messageId: string(),
        }),
        approval: never(),
      },
      (ctx: QueryContext<typeof requirements>, input) =>
        readBoundMessage(ctx.user.accounts.gmail, input, ctx.fetch),
    ),
  }),
});
