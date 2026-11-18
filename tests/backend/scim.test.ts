import { afterEach, describe, expect, it } from "vitest";
import { makeConnection, startServer, type TestServer } from "./helpers.js";

let server: TestServer;

afterEach(async () => {
  await server?.close();
});

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** What Entra ID sends to create a user. */
function entraUser(userName: string, extra: Record<string, unknown> = {}) {
  return {
    schemas: [
      USER_SCHEMA,
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
    ],
    externalId: `${userName}-ext`,
    userName,
    active: true,
    displayName: "Bob Smith",
    emails: [
      {
        primary: true,
        type: "work",
        value: userName.includes("@") ? userName : `${userName}@example.com`,
      },
    ],
    name: { givenName: "Bob", familyName: "Smith", formatted: "Bob Smith" },
    password: "never-kept",
    ...extra,
  };
}

async function setup(input: Record<string, unknown> = {}) {
  server = await startServer();
  const connection = await makeConnection(server, input);
  const scim = (method: string, path: string, body?: unknown) =>
    server.request(method, `${connection.base}${path}`, {
      body,
      token: connection.token,
    });
  return { connection, scim };
}

describe("SCIM token check", () => {
  it("refuses a missing or wrong token and a disabled connection", async () => {
    const { connection, scim } = await setup();
    expect(
      (await server.request("GET", `${connection.base}/Users`)).status,
    ).toBe(401);
    const wrong = await server.request("GET", `${connection.base}/Users`, {
      token: "scim_nope",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
    expect(
      (
        await server.request("GET", "/v2/not-a-connection/Users", {
          token: connection.token,
        })
      ).status,
    ).toBe(401);

    expect((await scim("GET", "/Users")).status).toBe(200);
    await server.request("PUT", `/connections/${connection.id}`, {
      body: { enabled: false },
      contentType: "application/json",
    });
    expect((await scim("GET", "/Users")).status).toBe(401);
  });

  it("stops answering a token after a new one is made", async () => {
    const { connection, scim } = await setup();
    const fresh = await server.request(
      "POST",
      `/connections/${connection.id}/token`,
      {
        body: {},
        contentType: "application/json",
      },
    );
    expect((await scim("GET", "/Users")).status).toBe(401);
    const ok = await server.request("GET", `${connection.base}/Users`, {
      token: fresh.body.token,
    });
    expect(ok.status).toBe(200);
  });

  it("serves discovery documents", async () => {
    const { scim } = await setup();
    const config = await scim("GET", "/ServiceProviderConfig");
    expect(config.status).toBe(200);
    expect(config.headers.get("content-type")).toMatch(
      /application\/scim\+json/,
    );
    expect(config.body.patch.supported).toBe(true);
    expect((await scim("GET", "/ResourceTypes")).body.totalResults).toBe(2);
    expect((await scim("GET", "/Schemas")).body.totalResults).toBe(3);
    expect((await scim("GET", `/Schemas/${USER_SCHEMA}`)).body.name).toBe(
      "User",
    );
  });

  it("answers 503 when Termix has no account API", async () => {
    server = await startServer({ withUsers: false });
    const connection = await makeConnection(server);
    const list = await server.request("GET", `${connection.base}/Users`, {
      token: connection.token,
    });
    expect(list.status).toBe(503);
  });
});

describe("SCIM users", () => {
  it("creates an account that links by email and never keeps the password", async () => {
    const { scim } = await setup();
    const created = await scim("POST", "/Users", entraUser("bob@example.com"));
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toContain(
      `/Users/${created.body.id}`,
    );
    expect(created.body.password).toBeUndefined();
    expect(created.body.userName).toBe("bob@example.com");

    const account = await server.users.findByUsername("bob@example.com");
    expect(account).toMatchObject({
      displayName: "Bob Smith",
      email: "bob@example.com",
      disabled: false,
    });

    const raw = server.db.sqlite
      .prepare("SELECT attributes FROM p_scim_users")
      .get() as { attributes: string };
    expect(raw.attributes).not.toContain("never-kept");
  });

  it("finds users with the filter Entra and Okta send before creating", async () => {
    const { scim } = await setup();
    await scim("POST", "/Users", entraUser("bob@example.com"));
    await scim("POST", "/Users", entraUser("alice@example.com"));
    const hit = await scim(
      "GET",
      `/Users?filter=${encodeURIComponent('userName eq "BOB@example.com"')}`,
    );
    expect(hit.body.totalResults).toBe(1);
    expect(hit.body.Resources[0].userName).toBe("bob@example.com");
    const miss = await scim(
      "GET",
      `/Users?filter=${encodeURIComponent('userName eq "carol@example.com"')}`,
    );
    expect(miss.body).toMatchObject({ totalResults: 0, Resources: [] });
    const paged = await scim("GET", "/Users?startIndex=2&count=1");
    expect(paged.body).toMatchObject({
      totalResults: 2,
      startIndex: 2,
      itemsPerPage: 1,
    });
    expect((await scim("GET", "/Users?filter=userName%20zz%20x")).status).toBe(
      400,
    );
  });

  it("refuses a second user with the same userName or externalId", async () => {
    const { scim } = await setup();
    await scim("POST", "/Users", entraUser("bob@example.com"));
    const again = await scim("POST", "/Users", entraUser("bob@example.com"));
    expect(again.status).toBe(409);
    expect(again.body.scimType).toBe("uniqueness");
    const sameExternal = await scim(
      "POST",
      "/Users",
      entraUser("bobby@example.com", { externalId: "bob@example.com-ext" }),
    );
    expect(sameExternal.status).toBe(409);
  });

  it("never touches an existing Termix account unless told, and never an admin", async () => {
    const { connection, scim } = await setup();
    server.users.add({ username: "carol@example.com" });
    server.users.add({ username: "root@example.com", isAdmin: true });
    expect(
      (await scim("POST", "/Users", entraUser("carol@example.com"))).status,
    ).toBe(409);

    await server.request("PUT", `/connections/${connection.id}`, {
      body: { adoptExisting: true },
      contentType: "application/json",
    });
    const adopted = await scim(
      "POST",
      "/Users",
      entraUser("carol@example.com"),
    );
    expect(adopted.status).toBe(201);
    expect(
      (await server.users.findByUsername("carol@example.com"))!.displayName,
    ).toBe("Bob Smith");
    expect(
      (await scim("POST", "/Users", entraUser("root@example.com"))).status,
    ).toBe(409);
  });

  it("turns the account off and back on with Entra's PATCH", async () => {
    const { scim } = await setup();
    const created = await scim("POST", "/Users", entraUser("bob@example.com"));
    const off = await scim("PATCH", `/Users/${created.body.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const account = (await server.users.findByUsername("bob@example.com"))!;
    expect(account).toMatchObject({ disabled: true, disabledReason: "scim" });

    const on = await scim("PATCH", `/Users/${created.body.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", value: { active: true } }],
    });
    expect(on.body.active).toBe(true);
    expect((await server.users.get(account.id))!.disabled).toBe(false);
  });

  it("leaves an admin's own disable alone", async () => {
    const { scim } = await setup();
    const created = await scim("POST", "/Users", entraUser("bob@example.com"));
    const account = (await server.users.findByUsername("bob@example.com"))!;
    await server.users.setDisabled(account.id, true, "admin");
    await scim(
      "PUT",
      `/Users/${created.body.id}`,
      entraUser("bob@example.com"),
    );
    expect((await server.users.get(account.id))!.disabledReason).toBe("admin");
  });

  it("renames the account and updates the email", async () => {
    const { scim } = await setup();
    const created = await scim("POST", "/Users", entraUser("bob@example.com"));
    await scim("PATCH", `/Users/${created.body.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        { op: "replace", path: "userName", value: "robert@example.com" },
        {
          op: "replace",
          path: 'emails[type eq "work"].value',
          value: "robert@example.com",
        },
      ],
    });
    const account = await server.users.findByUsername("robert@example.com");
    expect(account?.email).toBe("robert@example.com");
  });

  it("turns the account off on delete by default and brings it back on a new create", async () => {
    const { scim } = await setup();
    const created = await scim("POST", "/Users", entraUser("bob@example.com"));
    expect((await scim("DELETE", `/Users/${created.body.id}`)).status).toBe(
      204,
    );
    expect((await scim("GET", `/Users/${created.body.id}`)).status).toBe(404);
    const account = (await server.users.findByUsername("bob@example.com"))!;
    expect(account.disabled).toBe(true);

    const back = await scim("POST", "/Users", entraUser("bob@example.com"));
    expect(back.status).toBe(201);
    expect((await server.users.get(account.id))!.disabled).toBe(false);
  });

  it("deletes the account when the connection says so", async () => {
    const { scim } = await setup({ onDelete: "delete" });
    const created = await scim("POST", "/Users", entraUser("bob@example.com"));
    await scim("DELETE", `/Users/${created.body.id}`);
    expect(await server.users.findByUsername("bob@example.com")).toBeNull();
  });

  it("keeps connections apart", async () => {
    const { scim } = await setup();
    const other = await makeConnection(server, { name: "Okta" });
    const created = await scim("POST", "/Users", entraUser("bob@example.com"));
    const peek = await server.request(
      "GET",
      `${other.base}/Users/${created.body.id}`,
      { token: other.token },
    );
    expect(peek.status).toBe(404);
  });
});

describe("SCIM groups and roles", () => {
  it("gives mapped group roles and takes them away when members leave", async () => {
    const { connection, scim } = await setup({ defaultRoles: "viewer" });
    const bob = await scim("POST", "/Users", entraUser("bob@example.com"));
    const account = (await server.users.findByUsername("bob@example.com"))!;
    expect(server.users.rolesOf(account.id)).toEqual(["user", "viewer"]);

    const group = await scim("POST", "/Groups", {
      schemas: [GROUP_SCHEMA],
      displayName: "Ops",
      members: [{ value: bob.body.id }],
    });
    expect(group.status).toBe(201);
    expect(group.body.members).toHaveLength(1);

    const groups = await server.request(
      "GET",
      `/connections/${connection.id}/groups`,
    );
    const groupId = groups.body.groups[0].id;
    const mapped = await server.request(
      "PUT",
      `/connections/${connection.id}/groups/${groupId}`,
      {
        body: { roleName: "operator" },
        contentType: "application/json",
      },
    );
    expect(mapped.status).toBe(200);
    expect(server.users.rolesOf(account.id)).toEqual([
      "operator",
      "user",
      "viewer",
    ]);

    const removed = await scim("PATCH", `/Groups/${group.body.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        { op: "remove", path: `members[value eq "${bob.body.id}"]` },
      ],
    });
    expect(removed.status).toBe(204);
    expect(server.users.rolesOf(account.id)).toEqual(["user", "viewer"]);

    await scim("PATCH", `/Groups/${group.body.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        { op: "Add", path: "members", value: [{ value: bob.body.id }] },
      ],
    });
    expect(server.users.rolesOf(account.id)).toEqual([
      "operator",
      "user",
      "viewer",
    ]);
    const user = await scim("GET", `/Users/${bob.body.id}`);
    expect(user.body.groups).toEqual([
      expect.objectContaining({ value: group.body.id, display: "Ops" }),
    ]);

    await scim("DELETE", `/Groups/${group.body.id}`);
    expect(server.users.rolesOf(account.id)).toEqual(["user", "viewer"]);
  });

  it("only maps a group to admin when the connection allows it", async () => {
    const { connection, scim } = await setup();
    const bob = await scim("POST", "/Users", entraUser("bob@example.com"));
    await scim("POST", "/Groups", {
      displayName: "Admins",
      members: [{ value: bob.body.id }],
    });
    const groupId = (
      await server.request("GET", `/connections/${connection.id}/groups`)
    ).body.groups[0].id;
    const path = `/connections/${connection.id}/groups/${groupId}`;
    const opts = {
      body: { roleName: "admin" },
      contentType: "application/json",
    };
    expect((await server.request("PUT", path, opts)).status).toBe(400);

    await server.request("PUT", `/connections/${connection.id}`, {
      body: { allowAdmin: true },
      contentType: "application/json",
    });
    expect((await server.request("PUT", path, opts)).status).toBe(200);
    const account = (await server.users.findByUsername("bob@example.com"))!;
    expect((await server.users.get(account.id))!.isAdmin).toBe(true);

    await server.request("PUT", path, {
      body: { roleName: null },
      contentType: "application/json",
    });
    expect((await server.users.get(account.id))!.isAdmin).toBe(false);
  });

  it("refuses an unknown role and a duplicate group name", async () => {
    const { connection, scim } = await setup();
    await scim("POST", "/Groups", { displayName: "Ops" });
    expect((await scim("POST", "/Groups", { displayName: "ops" })).status).toBe(
      409,
    );
    const groupId = (
      await server.request("GET", `/connections/${connection.id}/groups`)
    ).body.groups[0].id;
    const bad = await server.request(
      "PUT",
      `/connections/${connection.id}/groups/${groupId}`,
      {
        body: { roleName: "nope" },
        contentType: "application/json",
      },
    );
    expect(bad.status).toBe(400);
  });

  it("lists groups without members when asked, like Entra does", async () => {
    const { scim } = await setup();
    const bob = await scim("POST", "/Users", entraUser("bob@example.com"));
    await scim("POST", "/Groups", {
      displayName: "Ops",
      members: [{ value: bob.body.id }],
    });
    const list = await scim(
      "GET",
      `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "Ops"')}`,
    );
    expect(list.body.totalResults).toBe(1);
    expect(list.body.Resources[0].members).toBeUndefined();
  });

  it("refuses a member that is not a user of the connection", async () => {
    const { scim } = await setup();
    const res = await scim("POST", "/Groups", {
      displayName: "Ops",
      members: [{ value: "nobody" }],
    });
    expect(res.status).toBe(400);
  });
});

describe("admin routes", () => {
  it("need scim.manage", async () => {
    server = await startServer({ permissions: [] });
    expect((await server.request("GET", "/connections")).status).toBe(403);
  });

  it("never send the token hash", async () => {
    server = await startServer();
    await makeConnection(server);
    const list = await server.request("GET", "/connections");
    expect(list.body.supported).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain("sha256");
  });
});
