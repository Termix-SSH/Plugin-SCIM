import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const connection = {
  id: 3,
  name: "Entra ID",
  enabled: true,
  onDelete: "disable",
  adoptExisting: false,
  allowAdmin: false,
  defaultRoles: "",
  lastRequestAt: null,
  baseUrl: "https://termix.example/plugin-api/scim/v2/abc",
  userCount: 2,
  groupCount: 1,
};

function apiWith(overrides: Record<string, unknown> = {}) {
  const get = vi.fn(async (path: string) => {
    if (path === "/connections")
      return { data: { supported: true, connections: [connection] } };
    if (path === "/roles")
      return {
        data: { roles: [{ name: "operator", displayName: "Operator" }] },
      };
    if (path.endsWith("/groups")) {
      return {
        data: {
          groups: [
            { id: 9, displayName: "Ops", roleName: null, memberCount: 4 },
          ],
        },
      };
    }
    if (path.endsWith("/events")) return { data: { events: [] } };
    return { data: {} };
  });
  return {
    get,
    post: vi.fn(),
    put: vi.fn(async () => ({ data: { connection } })),
    delete: vi.fn(),
    ...overrides,
  };
}

describe(`${manifest.id} activate`, () => {
  it("registers only the connections setting", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.settingsComponents()).toEqual(["connections"]);
  });

  it("lists connections with their counts", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: apiWith() as never,
    });
    rendered.renderSettingsComponent("connections");
    expect(await screen.findByText("Entra ID")).toBeTruthy();
    expect(
      screen.getByText(/2 users \| 1 group \| No requests yet/),
    ).toBeTruthy();
  });

  it("shows the token once after making a connection", async () => {
    const post = vi.fn(async () => ({
      data: { connection, token: "scim_secret" },
    }));
    const api = apiWith({ post });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api as never,
    });
    rendered.renderSettingsComponent("connections");
    await screen.findByText("Entra ID");
    fireEvent.click(screen.getByText(locales.connections.add));
    fireEvent.change(
      await screen.findByPlaceholderText(locales.connections.namePlaceholder),
      {
        target: { value: "Okta" },
      },
    );
    fireEvent.click(screen.getByText(locales.connections.save));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/connections");
    expect(body).toMatchObject({
      name: "Okta",
      onDelete: "disable",
      adoptExisting: false,
    });
    expect(await screen.findByDisplayValue("scim_secret")).toBeTruthy();
  });

  it("maps a group to a role from the editor", async () => {
    const api = apiWith();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api as never,
    });
    rendered.renderSettingsComponent("connections");
    fireEvent.click(await screen.findByTitle(locales.connections.edit));
    expect(await screen.findByText("Ops")).toBeTruthy();
    expect(screen.getByDisplayValue(connection.baseUrl)).toBeTruthy();
  });

  it("removes everything on deactivate", async () => {
    const app = await renderWithApp(plugin, { manifest, locales });
    await app.deactivate();
    expect(app.registered.settingsComponents()).toEqual([]);
  });
});
