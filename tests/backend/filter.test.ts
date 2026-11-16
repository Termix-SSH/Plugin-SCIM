import { describe, expect, it } from "vitest";
import {
  matches,
  parseFilter,
  simpleEquals,
} from "../../src/backend/scim/filter.js";
import { ScimError } from "../../src/backend/scim/errors.js";

const user = {
  userName: "Bob@Example.com",
  externalId: "abc-1",
  active: true,
  name: { givenName: "Bob", familyName: "Smith" },
  emails: [
    { value: "bob@home.example", type: "home" },
    { value: "bob@example.com", type: "work", primary: true },
  ],
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
    department: "Ops",
  },
};

const check = (filter: string) => matches(parseFilter(filter), user);

describe("SCIM filters", () => {
  it("matches userName without case, the way Entra and Okta look users up", () => {
    expect(check('userName eq "bob@example.com"')).toBe(true);
    expect(check('userName eq "alice@example.com"')).toBe(false);
  });

  it("matches externalId with case", () => {
    expect(check('externalId eq "abc-1"')).toBe(true);
    expect(check('externalId eq "ABC-1"')).toBe(false);
  });

  it("handles value paths and sub attributes", () => {
    expect(check('emails[type eq "work"].value eq "bob@example.com"')).toBe(
      true,
    );
    expect(check('emails[type eq "home"].value eq "bob@example.com"')).toBe(
      false,
    );
    expect(check('emails[type eq "work" and primary eq true]')).toBe(true);
    expect(check('emails.value co "home"')).toBe(true);
    expect(check('name.givenName sw "B"')).toBe(true);
  });

  it("handles and, or, not, grouping, pr and booleans", () => {
    expect(
      check(
        'active eq true and (name.familyName eq "Jones" or name.familyName eq "Smith")',
      ),
    ).toBe(true);
    expect(check("not (active eq true)")).toBe(false);
    expect(check("title pr")).toBe(false);
    expect(check("name pr")).toBe(true);
  });

  it("reads enterprise attributes by URN or bare name", () => {
    expect(
      check(
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department eq "ops"',
      ),
    ).toBe(true);
    expect(check('department eq "Ops"')).toBe(true);
  });

  it("refuses broken filters with invalidFilter", () => {
    for (const bad of [
      "userName eq",
      'userName zz "x"',
      '(userName eq "x"',
      'userName eq "x',
      "a".repeat(3000),
    ]) {
      try {
        parseFilter(bad);
        throw new Error(`parsed ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ScimError);
        expect((error as ScimError).scimType).toBe("invalidFilter");
      }
    }
  });

  it("finds the value of a simple equality for fast lookups", () => {
    expect(simpleEquals(parseFilter('userName eq "x"'), "username")).toBe("x");
    expect(
      simpleEquals(
        parseFilter('userName eq "x" and active eq true'),
        "username",
      ),
    ).toBeNull();
  });
});
