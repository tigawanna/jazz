// @vitest-environment happy-dom
import {
  render as renderSvelte,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AuthProvider from "../svelte.svelte";
import { createAuthClient } from "better-auth/client";
import { jazzPluginClient } from "../client";
import TestAuthProviderWrapper from "./TestAuthProviderWrapper.svelte";

describe("AuthProvider", () => {
  it("should throw if no JazzContext is set", () => {
    const betterAuthClient = createAuthClient({
      plugins: [jazzPluginClient()],
    });

    expect(() => {
      renderSvelte(AuthProvider, {
        props: {
          betterAuthClient,
        },
      });
    }).toThrow("useJazzContext must be used within a JazzSvelteProvider");
  });

  it("should render with JazzSvelteProvider", async () => {
    const customFetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(null), {
        headers: { "content-type": "application/json" },
      }),
    );
    const betterAuthClient = createAuthClient({
      plugins: [jazzPluginClient()],
      fetchOptions: { customFetchImpl },
    });

    renderSvelte(TestAuthProviderWrapper, {
      props: {
        betterAuthClient,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-provider")).toBeTruthy();
      expect(customFetchImpl).toHaveBeenCalled();
      expect(betterAuthClient.useSession.get().isPending).toBe(false);
    });
  });
});
