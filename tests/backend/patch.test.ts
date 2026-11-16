import { describe, expect, it } from "vitest";
import { applyPatch, readPatchBody } from "../../src/backend/scim/patch.js";
import { userProfile } from "../../src/backend/scim/resources.js";

const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

function patch(resource: Record<string, unknown>, operations: unknown[]) {
  return applyPatch(resource, readPatchBody({ Operations: operations }));
}

describe("SCIM PATCH", () => {
  it("takes Entra's path-less replace with dotted keys and active as a string", () => {
    const out = patch(
      { userName: "bob", active: true, name: { givenName: "Bob" } },
      [
        {
          op: "Replace",
          value: {
            active: "False",
            "name.familyName": "Smith",
            [`${ENTERPRISE}:department`]: "Ops",
          },
        },
      ],
    );
    expect(out.name).toEqual({ givenName: "Bob", familyName: "Smith" });
    expect(out[ENTERPRISE]).toEqual({ department: "Ops" });
    expect(userProfile(out).active).toBe(false);
  });

  it("creates a work email when Entra replaces one that is not there", () => {
    const out = patch({ userName: "bob" }, [
      {
        op: "replace",
        path: 'emails[type eq "work"].value',
        value: "bob@example.com",
      },
    ]);
    expect(out.emails).toEqual([{ type: "work", value: "bob@example.com" }]);
    expect(userProfile(out).email).toBe("bob@example.com");
  });

  it("changes a matching email in place", () => {
    const out = patch(
      {
        userName: "bob",
        emails: [
          { type: "work", value: "old@example.com" },
          { type: "home", value: "h@x.io" },
        ],
      },
      [
        {
          op: "replace",
          path: 'emails[type eq "work"].value',
          value: "new@example.com",
        },
      ],
    );
    expect(out.emails).toEqual([
      { type: "work", value: "new@example.com" },
      { type: "home", value: "h@x.io" },
    ]);
  });

  it("takes Okta's replace with an object value", () => {
    const out = patch({ userName: "bob", active: true }, [
      { op: "replace", value: { active: false } },
    ]);
    expect(out.active).toBe(false);
  });

  it("takes a whole extension object as one key", () => {
    const out = patch({ userName: "bob" }, [
      {
        op: "add",
        value: {
          [ENTERPRISE]: { department: "Ops", manager: { value: "m1" } },
        },
      },
    ]);
    expect(out[ENTERPRISE]).toEqual({
      department: "Ops",
      manager: { value: "m1" },
    });
  });

  it("adds, removes by filter and removes by value list on members", () => {
    let group: Record<string, unknown> = {
      displayName: "Ops",
      members: [{ value: "a" }],
    };
    group = patch(group, [
      { op: "add", path: "members", value: [{ value: "b" }, { value: "a" }] },
    ]);
    expect(group.members).toEqual([{ value: "a" }, { value: "b" }]);
    group = patch(group, [{ op: "remove", path: 'members[value eq "a"]' }]);
    expect(group.members).toEqual([{ value: "b" }]);
    group = patch(group, [
      { op: "Remove", path: "members", value: [{ value: "b" }] },
    ]);
    expect(group.members).toEqual([]);
  });

  it("removes an attribute and a sub attribute", () => {
    const out = patch(
      {
        userName: "bob",
        title: "x",
        name: { givenName: "B", familyName: "S" },
      },
      [
        { op: "remove", path: "title" },
        { op: "remove", path: "name.familyName" },
      ],
    );
    expect(out.title).toBeUndefined();
    expect(out.name).toEqual({ givenName: "B" });
  });

  it("refuses a bad body", () => {
    expect(() => readPatchBody({})).toThrow(/Operations/);
    expect(() => readPatchBody({ Operations: [{ op: "move" }] })).toThrow(
      /Unknown op/,
    );
    expect(() => patch({}, [{ op: "remove" }])).toThrow(/needs a path/);
  });
});
