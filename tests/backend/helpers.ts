import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import type {
  TermixRole,
  TermixUser,
  UsersApi,
} from "../../src/backend/termix-users.js";

export const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
export const manifest = manifestJson as unknown as PluginManifest;

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** An in-memory stand in for core's ctx.users account calls. */
export class FakeUsers implements UsersApi {
  accounts = new Map<string, TermixUser>();
  roles = new Map<string, Set<string>>();
  linkByEmail = new Set<string>();
  knownRoles: TermixRole[] = [
    { name: "admin", displayName: "Admin", isSystem: true },
    { name: "user", displayName: "User", isSystem: true },
    { name: "operator", displayName: "Operator", isSystem: false },
    { name: "viewer", displayName: "Viewer", isSystem: false },
  ];
  private next = 1;

  add(account: Partial<TermixUser> & { username: string }): TermixUser {
    const user: TermixUser = {
      id: `u${this.next++}`,
      displayName: null,
      email: null,
      isAdmin: false,
      disabled: false,
      disabledReason: null,
      ...account,
    };
    this.accounts.set(user.id, user);
    this.roles.set(user.id, new Set([user.isAdmin ? "admin" : "user"]));
    return user;
  }

  rolesOf(id: string): string[] {
    return [...(this.roles.get(id) ?? [])].sort();
  }

  async get(id: string) {
    const found = this.accounts.get(id);
    return found ? { ...found } : null;
  }
  async findByUsername(name: string) {
    return [...this.accounts.values()].find((u) => u.username === name) ?? null;
  }
  async findByEmail(email: string) {
    return [...this.accounts.values()].find((u) => u.email === email) ?? null;
  }
  async listRoles() {
    return this.knownRoles;
  }
  async create(input: {
    username: string;
    displayName?: string | null;
    email?: string | null;
    linkByEmail?: boolean;
  }) {
    if (await this.findByUsername(input.username))
      throw coded("username_taken", "taken");
    if (input.email && (await this.findByEmail(input.email)))
      throw coded("email_taken", "taken");
    const user = this.add({
      username: input.username,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
    });
    if (input.linkByEmail) this.linkByEmail.add(user.id);
    return { ...user };
  }
  async update(
    id: string,
    input: {
      username?: string;
      displayName?: string | null;
      email?: string | null;
    },
  ) {
    const user = this.accounts.get(id);
    if (!user) throw coded("not_found", "gone");
    if (input.username !== undefined) {
      const holder = await this.findByUsername(input.username);
      if (holder && holder.id !== id) throw coded("username_taken", "taken");
      user.username = input.username;
    }
    if (input.displayName !== undefined) user.displayName = input.displayName;
    if (input.email !== undefined) user.email = input.email;
    return { ...user };
  }
  async setDisabled(id: string, disabled: boolean, reason?: string) {
    const user = this.accounts.get(id);
    if (!user) throw coded("not_found", "gone");
    user.disabled = disabled;
    user.disabledReason = disabled ? (reason ?? "admin") : null;
  }
  async delete(id: string) {
    if (!this.accounts.delete(id)) throw coded("not_found", "gone");
  }
  async syncRoles(id: string, plan: { desired: string[]; managed: string[] }) {
    const set = this.roles.get(id) ?? new Set<string>();
    for (const name of plan.managed)
      if (!plan.desired.includes(name)) set.delete(name);
    for (const name of plan.desired) set.add(name);
    this.roles.set(id, set);
  }
  async setAdmin(id: string, isAdmin: boolean) {
    const user = this.accounts.get(id)!;
    user.isAdmin = isAdmin;
    const set = this.roles.get(id)!;
    set.delete(isAdmin ? "user" : "admin");
    set.add(isAdmin ? "admin" : "user");
  }
}

export interface TestServer {
  db: TestDb;
  mock: MockPluginContext;
  users: FakeUsers;
  request: (
    method: string,
    path: string,
    options?: {
      user?: string;
      body?: unknown;
      token?: string | null;
      contentType?: string;
    },
    // Bodies vary per test; asserting on them is the point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any; headers: Headers }>;
  close: () => Promise<void>;
}

const realFetch = globalThis.fetch;

export async function startServer(
  options: { permissions?: string[]; withUsers?: boolean } = {},
): Promise<TestServer> {
  const db = await createTestDb(pluginDir);
  const users = new FakeUsers();
  // Core's users table, for the refUser foreign key.
  const insertUser = db.sqlite.prepare(
    "INSERT INTO users (id, username, is_admin) VALUES (?, ?, 0)",
  );
  const add = users.add.bind(users);
  users.add = (account) => {
    const user = add(account);
    insertUser.run(user.id, `${user.id}-${user.username}`);
    return user;
  };
  db.sqlite
    .prepare("INSERT INTO users (id, username, is_admin) VALUES (?, ?, 1)")
    .run("admin", "admin");

  let router: Router | null = null;
  const mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ["scim.manage"],
  });
  if (options.withUsers !== false) {
    Object.assign(mock.ctx.users as object, users);
    for (const key of Object.getOwnPropertyNames(FakeUsers.prototype)) {
      if (key === "constructor") continue;
      const value = (users as unknown as Record<string, unknown>)[key];
      if (typeof value === "function") {
        (mock.ctx.users as unknown as Record<string, unknown>)[key] =
          value.bind(users);
      }
    }
  }

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  // Like core: JSON is parsed before the plugin, SCIM JSON is not.
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") || undefined);
    next();
  });
  app.use("/plugin-api/scim", (req, res, next) => router!(req, res, next));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    db,
    mock,
    users,
    async request(
      method,
      path,
      { user = "admin", body, token, contentType } = {},
    ) {
      const payload =
        body !== undefined && method !== "GET"
          ? JSON.stringify(body)
          : undefined;
      const headers: Record<string, string> = { "x-test-user": user };
      if (payload !== undefined)
        headers["content-type"] = contentType ?? "application/scim+json";
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await realFetch(
        `http://127.0.0.1:${port}/plugin-api/scim${path}`,
        {
          method,
          headers,
          body: payload,
        },
      );
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return {
        status: response.status,
        body: parsed,
        headers: response.headers,
      };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

/** Makes a connection through the admin API and returns its SCIM base and token. */
export async function makeConnection(
  server: TestServer,
  input: Record<string, unknown> = {},
): Promise<{ id: number; base: string; token: string }> {
  const made = await server.request("POST", "/connections", {
    body: { name: "Entra ID", ...input },
    contentType: "application/json",
  });
  if (made.status !== 201)
    throw new Error(`connection: ${made.status} ${JSON.stringify(made.body)}`);
  const url = new URL(made.body.connection.baseUrl, "http://x");
  return {
    id: made.body.connection.id,
    base: url.pathname.replace(/^\/plugin-api\/scim/, ""),
    token: made.body.token,
  };
}
