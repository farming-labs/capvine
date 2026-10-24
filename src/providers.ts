import { createGoogleProvider, createOidcProvider } from "./oauth.ts";
import { createSlackProvider } from "./slack.ts";
import type { AccountProvider } from "./accounts.ts";
export type { AccountProvider } from "./accounts.ts";

export interface ProviderDefinition {
  id: string;
  create(callbackURL: string): AccountProvider;
}

function provider<T extends { redirectUri: string }>(
  id: string,
  factory: (options: T) => AccountProvider,
  options: Omit<T, "redirectUri"> & { redirectUri?: string },
): AccountProvider | ProviderDefinition {
  const settings = { ...options };
  if (settings.redirectUri !== undefined) return factory(settings as T);
  return Object.freeze({
    id,
    create: (callbackURL: string) =>
      factory({ ...settings, redirectUri: callbackURL } as T),
  });
}

type GoogleOptions = Parameters<typeof createGoogleProvider>[0];
export function google(options: GoogleOptions): AccountProvider;
export function google(
  options: Omit<GoogleOptions, "redirectUri"> & { redirectUri?: never },
): ProviderDefinition;
export function google(
  options: Omit<GoogleOptions, "redirectUri"> & { redirectUri?: string },
): AccountProvider | ProviderDefinition;
export function google(
  options: Omit<GoogleOptions, "redirectUri"> & { redirectUri?: string },
) {
  return provider("google", createGoogleProvider, options);
}

type OidcOptions = Parameters<typeof createOidcProvider>[0];
export function oidc(options: OidcOptions): AccountProvider;
export function oidc(
  options: Omit<OidcOptions, "redirectUri"> & { redirectUri?: never },
): ProviderDefinition;
export function oidc(
  options: Omit<OidcOptions, "redirectUri"> & { redirectUri?: string },
): AccountProvider | ProviderDefinition;
export function oidc(
  options: Omit<OidcOptions, "redirectUri"> & { redirectUri?: string },
) {
  return provider(options.id, createOidcProvider, {
    ...options,
    scopes: [...options.scopes],
  });
}

type SlackOptions = Parameters<typeof createSlackProvider>[0];
export function slack(options: SlackOptions): AccountProvider;
export function slack(
  options: Omit<SlackOptions, "redirectUri"> & { redirectUri?: never },
): ProviderDefinition;
export function slack(
  options: Omit<SlackOptions, "redirectUri"> & { redirectUri?: string },
): AccountProvider | ProviderDefinition;
export function slack(
  options: Omit<SlackOptions, "redirectUri"> & { redirectUri?: string },
) {
  return provider("slack", createSlackProvider, {
    ...options,
    scopes: [...options.scopes],
  });
}
