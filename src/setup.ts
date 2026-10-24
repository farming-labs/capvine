import { createApplication, type ApplicationOptions } from "./application.ts";
import {
  createConfiguredCapvine,
  type CapvineOptions,
} from "./setup-internal.ts";

export { workflow } from "./setup-internal.ts";
export type { CapvineOptions, ResourceSetup } from "./setup-internal.ts";
export type { ApplicationOptions, OwnerSession } from "./application.ts";

export function createCapvine(
  options: ApplicationOptions,
): ReturnType<typeof createApplication>;
export function createCapvine(
  options: CapvineOptions,
): ReturnType<typeof createConfiguredCapvine>;
export function createCapvine(options: ApplicationOptions | CapvineOptions) {
  return "storage" in options
    ? createApplication(options)
    : createConfiguredCapvine(options);
}
