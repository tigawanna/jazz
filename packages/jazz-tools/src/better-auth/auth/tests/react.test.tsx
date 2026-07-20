// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../react";
import { createAuthClient } from "better-auth/client";
import { jazzPluginClient } from "../client";
import { JazzReactProvider } from "jazz-tools/react";

describe("AuthProvider", () => {
  it("should throw if no JazzContext is set", () => {
    const betterAuthClient = createAuthClient({
      plugins: [jazzPluginClient()],
    });

    expect(() => {
      render(
        <AuthProvider betterAuthClient={betterAuthClient}>
          <div />
        </AuthProvider>,
      );
    }).toThrow(
      "You need to set up a JazzProvider on top of your app to use this hook.",
    );
  });

  it("should render with JazzReactProvider", async () => {
    const betterAuthClient = createAuthClient({
      plugins: [jazzPluginClient()],
    });

    render(
      <JazzReactProvider sync={{ peer: "ws://", when: "never" }}>
        <AuthProvider betterAuthClient={betterAuthClient}>
          <div data-testid="auth-provider" />
        </AuthProvider>
      </JazzReactProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("auth-provider")).toBeTruthy();
    });
  });
});
