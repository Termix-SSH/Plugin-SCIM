import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * ctx.users account calls from plugin API 2.9 (Termix 26.11.2). Typed here so
 * the plugin builds against an SDK that predates them; the plugin checks they
 * exist before using them.
 */
export interface TermixUser {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
  disabled: boolean;
  disabledReason: string | null;
}

export interface TermixRole {
  name: string;
  displayName: string;
  isSystem: boolean;
}

export interface UsersApi {
  get: (userId: string) => Promise<TermixUser | null>;
  findByUsername: (username: string) => Promise<TermixUser | null>;
  findByEmail: (email: string) => Promise<TermixUser | null>;
  listRoles: () => Promise<TermixRole[]>;
  create: (input: {
    username: string;
    displayName?: string | null;
    email?: string | null;
    linkByEmail?: boolean;
  }) => Promise<TermixUser>;
  update: (
    userId: string,
    input: {
      username?: string;
      displayName?: string | null;
      email?: string | null;
    },
  ) => Promise<TermixUser>;
  setDisabled: (
    userId: string,
    disabled: boolean,
    reason?: string,
  ) => Promise<void>;
  delete: (userId: string) => Promise<void>;
  syncRoles: (
    userId: string,
    roles: { desired: string[]; managed: string[] },
  ) => Promise<void>;
  setAdmin: (userId: string, isAdmin: boolean) => Promise<void>;
}

/** Error codes core puts on a failed ctx.users call. */
export type UsersErrorCode =
  "username_taken" | "email_taken" | "last_admin" | "not_found" | "invalid";

export function usersErrorCode(error: unknown): UsersErrorCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? (code as UsersErrorCode) : null;
}

/** The account calls, or null on a Termix too old to have them. */
export function usersApi(ctx: PluginContext): UsersApi | null {
  const users = ctx.users as unknown as Partial<UsersApi> | undefined;
  return users && typeof users.create === "function"
    ? (users as UsersApi)
    : null;
}
