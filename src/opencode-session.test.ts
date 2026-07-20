import { describe, expect, test } from "bun:test";

import {
  createOpenCodeSessionAdapter,
  OpenCodeSessionAdapter,
  OpenCodeSessionError,
} from "./opencode-session.js";

const VALID_OPENCODE_MESSAGE_ID = "msg_019abcdef001AbCdEfGhIjKlMn";

const session = (id: string, parentID?: string) => ({
  directory: "/workspace",
  id,
  parentID,
  projectID: "project-1",
  time: { created: 1000, updated: 2000 },
  title: id,
  version: "1",
});

const success = <Value>(data: Value) => ({ data, error: undefined });

const transport = (
  overrides: Record<string, (input: unknown) => Promise<unknown>> = {}
) => ({
  abort: async () => success(true),
  children: async () => success([session("child-1", "parent-1")]),
  create: async () => success(session("child-1", "parent-1")),
  delete: async () => success(true),
  diff: async () =>
    success([
      {
        additions: 2,
        deletions: 1,
        file: "./src\\worker.ts",
        patch: "diff --git a/src/worker.ts b/src/worker.ts",
        status: "modified",
      },
    ]),
  get: async () => success(session("child-1", "parent-1")),
  message: async () =>
    success({
      info: { id: "message-1", role: "assistant", sessionID: "child-1" },
      parts: [
        {
          id: "part-1",
          messageID: "message-1",
          sessionID: "child-1",
          text: "Completed.",
          type: "text",
        },
      ],
    }),
  messages: async () =>
    success([
      {
        info: { id: "message-1", role: "assistant", sessionID: "child-1" },
        parts: [
          {
            id: "part-1",
            messageID: "message-1",
            sessionID: "child-1",
            text: "Completed.",
            type: "text",
          },
        ],
      },
    ]),
  promptAsync: async () => success({}),
  revert: async () =>
    success({
      ...session("child-1", "parent-1"),
      revert: { messageID: "message-1" },
    }),
  status: async () => success({ "child-1": { type: "busy" } }),
  unrevert: async () => success(session("child-1", "parent-1")),
  update: async () => success(session("child-1", "parent-1")),
  ...overrides,
});

const permissionTransport = (
  overrides: Record<string, (input: unknown) => Promise<unknown>> = {}
) => ({
  reply: async (_input?: unknown) => success(true),
  ...overrides,
});

describe("OpenCodeSessionAdapter", () => {
  test("returns validated operation-specific session data", async () => {
    const adapter = new OpenCodeSessionAdapter(
      transport(),
      "/workspace",
      permissionTransport()
    );

    expect((await adapter.get("child-1")).id).toBe("child-1");
    expect(
      await adapter.createChild({ parentID: "parent-1", title: "worker" })
    ).toMatchObject({ id: "child-1", parentID: "parent-1" });
    expect(await adapter.children("parent-1")).toHaveLength(1);
    expect(await adapter.status()).toEqual({ "child-1": { type: "busy" } });
    expect(await adapter.messages("child-1")).toHaveLength(1);
    expect((await adapter.message("child-1", "message-1")).info.id).toBe(
      "message-1"
    );
    expect(await adapter.diff("child-1", "message-1")).toEqual([
      {
        additions: 2,
        deletions: 1,
        patch: "diff --git a/src/worker.ts b/src/worker.ts",
        path: "src/worker.ts",
        status: "modified",
      },
    ]);
    await expect(
      adapter.promptAsync({
        agent: "terra-max",
        messageID: VALID_OPENCODE_MESSAGE_ID,
        sessionID: "child-1",
        text: "Continue.",
      })
    ).resolves.toBeUndefined();
    await expect(adapter.abort("child-1")).resolves.toBeUndefined();
    await expect(adapter.remove("child-1")).resolves.toBeUndefined();
  });

  test("preserves bounded native retry details including optional recovery action", async () => {
    const adapter = new OpenCodeSessionAdapter(
      transport({
        status: async () =>
          success({
            "child-1": {
              action: {
                label: "open settings",
                link: "https://opencode.ai/settings",
                message: "Enable available balance.",
                provider: "openai",
                reason: "account_rate_limit",
                title: "Usage limit reached",
              },
              attempt: 3,
              message:
                "Provider request failed and will be retried. Please include the request ID 4488a6e8-f303-4abe-affa-90b4be286941 in your message.",
              next: 1_784_481_739_000,
              type: "retry",
            },
          }),
      }),
      "/workspace"
    );

    expect((await adapter.status())["child-1"]).toEqual({
      action: {
        label: "open settings",
        link: "https://opencode.ai/settings",
        message: "Enable available balance.",
        provider: "openai",
        reason: "account_rate_limit",
        title: "Usage limit reached",
      },
      attempt: 3,
      message: "Provider request failed and will be retried.",
      next: 1_784_481_739_000,
      type: "retry",
    });
  });

  test("builds exact native child creation and cleanup requests", async () => {
    const requests: unknown[] = [];
    const adapter = new OpenCodeSessionAdapter(
      transport({
        create: (input) => {
          requests.push(input);
          return Promise.resolve(success(session("child-1", "parent-1")));
        },
        delete: (input) => {
          requests.push(input);
          return Promise.resolve(success(true));
        },
      }),
      "/workspace"
    );

    await adapter.createChild({
      directory: "/other",
      parentID: "parent-1",
      title: "worker (@luna-medium subagent)",
    });
    await adapter.remove("child-1", "/other");

    expect(requests).toEqual([
      {
        body: {
          parentID: "parent-1",
          title: "worker (@luna-medium subagent)",
        },
        query: { directory: "/other" },
      },
      { path: { id: "child-1" }, query: { directory: "/other" } },
    ]);
  });

  test("builds exact specific-message and message-diff requests", async () => {
    const requests: unknown[] = [];
    const adapter = new OpenCodeSessionAdapter(
      transport({
        diff: (input) => {
          requests.push(input);
          return Promise.resolve(success([]));
        },
        message: (input) => {
          requests.push(input);
          return Promise.resolve(
            success({
              info: {
                id: "message-1",
                role: "assistant",
                sessionID: "child-1",
              },
              parts: [],
            })
          );
        },
      }),
      "/workspace",
      permissionTransport()
    );

    await adapter.message("child-1", "message-1", "/other");
    await adapter.diff("child-1", "message-1", "/other");

    expect(requests).toEqual([
      {
        path: { id: "child-1", messageID: "message-1" },
        query: { directory: "/other" },
      },
      {
        path: { id: "child-1" },
        query: { directory: "/other", messageID: "message-1" },
      },
    ]);
  });

  test("rejects foreign specific messages, parts, and malformed runtime diffs", async () => {
    const foreignMessage = new OpenCodeSessionAdapter(
      transport({
        message: async () =>
          success({
            info: {
              id: "other-message",
              role: "assistant",
              sessionID: "child-1",
            },
            parts: [],
          }),
      }),
      "/workspace",
      permissionTransport()
    );
    const foreignPart = new OpenCodeSessionAdapter(
      transport({
        message: async () =>
          success({
            info: {
              id: "message-1",
              role: "assistant",
              sessionID: "child-1",
            },
            parts: [
              {
                id: "part-1",
                messageID: "other-message",
                sessionID: "child-1",
                text: "wrong owner",
                type: "text",
              },
            ],
          }),
      }),
      "/workspace",
      permissionTransport()
    );
    const staleLegacyDiff = new OpenCodeSessionAdapter(
      transport({
        diff: async () =>
          success([
            {
              additions: 1,
              after: "new",
              before: "old",
              deletions: 1,
              file: "src/worker.ts",
            },
          ]),
      }),
      "/workspace",
      permissionTransport()
    );

    await expect(
      foreignMessage.message("child-1", "message-1")
    ).rejects.toMatchObject({ code: "OPENCODE_MESSAGE_ID_MISMATCH" });
    await expect(
      foreignPart.message("child-1", "message-1")
    ).rejects.toMatchObject({ code: "OPENCODE_MESSAGE_PART_MISMATCH" });
    await expect(
      staleLegacyDiff.diff("child-1", "message-1")
    ).rejects.toMatchObject({ code: "OPENCODE_RESPONSE_INVALID" });
  });

  test("sends only appended permission rules and validates the merged session", async () => {
    const requests: unknown[] = [];
    const existing = {
      action: "ask" as const,
      pattern: "*",
      permission: "edit",
    };
    const appended = {
      action: "allow" as const,
      pattern: "src/**",
      permission: "edit",
    };
    const adapter = new OpenCodeSessionAdapter(
      transport({
        get: async () =>
          success({ ...session("child-1"), permission: [existing] }),
        update: (input) => {
          requests.push(input);
          return Promise.resolve(
            success({
              ...session("child-1"),
              permission: [existing, appended],
            })
          );
        },
      }),
      "/workspace",
      permissionTransport()
    );

    expect(
      await adapter.appendPermissions("child-1", [appended])
    ).toMatchObject({ permission: [existing, appended] });
    expect(requests).toEqual([
      {
        body: { permission: [appended] },
        path: { id: "child-1" },
        query: { directory: "/workspace" },
      },
    ]);
  });

  test.each([
    "plain-uuid",
    "msg_message-2",
  ])("rejects non-sortable OpenCode prompt message ID %s", async (messageID) => {
    const adapter = new OpenCodeSessionAdapter(
      transport(),
      "/workspace",
      permissionTransport()
    );

    await expect(
      adapter.promptAsync({
        agent: "terra-max",
        messageID,
        sessionID: "child-1",
        text: "Continue.",
      })
    ).rejects.toThrow();
  });

  test("sends corrective permission rejection through the validated boundary", async () => {
    const requests: unknown[] = [];
    const adapter = new OpenCodeSessionAdapter(
      transport(),
      "/workspace",
      permissionTransport({
        reply: (input) => {
          requests.push(input);
          return Promise.resolve(success(true));
        },
      })
    );

    await adapter.replyPermission({
      directory: "/other",
      feedback: "Stay inside the authored scope.",
      requestID: "permission-1",
      reply: "reject",
    });

    expect(requests).toEqual([
      {
        body: {
          message: "Stay inside the authored scope.",
          reply: "reject",
        },
        path: { requestID: "permission-1" },
        query: { directory: "/other" },
      },
    ]);
  });

  test("calls the current permission reply route through the validated low-level bridge", async () => {
    const requests: unknown[] = [];
    const client = {
      _client: {
        post: (input: unknown) => {
          requests.push(input);
          return Promise.resolve(success(true));
        },
      },
      session: transport(),
    };
    const adapter = createOpenCodeSessionAdapter(client, "/workspace");

    await adapter.replyPermission({
      requestID: "permission-1",
      reply: "once",
    });

    expect(requests).toEqual([
      {
        body: { reply: "once" },
        headers: { "Content-Type": "application/json" },
        path: { requestID: "permission-1" },
        query: { directory: "/workspace" },
        url: "/permission/{requestID}/reply",
      },
    ]);
  });

  test("reverts and unreverts exact session boundaries", async () => {
    const requests: unknown[] = [];
    const adapter = new OpenCodeSessionAdapter(
      transport({
        revert: (input) => {
          requests.push(input);
          return Promise.resolve(
            success({
              ...session("child-1"),
              revert: { messageID: "message-1", partID: "part-1" },
            })
          );
        },
        unrevert: (input) => {
          requests.push(input);
          return Promise.resolve(success(session("child-1")));
        },
      }),
      "/workspace",
      permissionTransport()
    );

    await adapter.revert({
      messageID: "message-1",
      partID: "part-1",
      sessionID: "child-1",
    });
    await adapter.unrevert("child-1");

    expect(requests).toEqual([
      {
        body: { messageID: "message-1", partID: "part-1" },
        path: { id: "child-1" },
        query: { directory: "/workspace" },
      },
      {
        path: { id: "child-1" },
        query: { directory: "/workspace" },
      },
    ]);
  });

  test.each([
    ["busy revert", "SessionBusyError", "OPENCODE_SESSION_BUSY"],
    ["missing revert session", "NotFoundError", "OPENCODE_SESSION_NOT_FOUND"],
  ])("classifies %s", async (_label, name, code) => {
    const error =
      name === "SessionBusyError"
        ? {
            _tag: name,
            message: "Session is busy.",
            sessionID: "child-1",
          }
        : { data: { message: "Session was not found." }, name };
    const adapter = new OpenCodeSessionAdapter(
      transport({
        revert: async () => ({ data: undefined, error }),
      }),
      "/workspace",
      permissionTransport()
    );

    await expect(
      adapter.revert({ messageID: "message-1", sessionID: "child-1" })
    ).rejects.toMatchObject({ code });
  });

  test("builds exact Sol continuation prompt and worker abort requests", async () => {
    const requests: unknown[] = [];
    const adapter = new OpenCodeSessionAdapter(
      transport({
        abort: (input) => {
          requests.push(input);
          return Promise.resolve(success(true));
        },
        promptAsync: (input) => {
          requests.push(input);
          return Promise.resolve(success({}));
        },
      }),
      "/workspace"
    );

    await adapter.promptAsync({
      agent: "sol",
      directory: "/other",
      messageID: VALID_OPENCODE_MESSAGE_ID,
      sessionID: "parent-1",
      text: "Continue.",
    });
    await adapter.abort("child-1", "/other");

    expect(requests).toEqual([
      {
        body: {
          agent: "sol",
          messageID: VALID_OPENCODE_MESSAGE_ID,
          parts: [{ text: "Continue.", type: "text" }],
        },
        path: { id: "parent-1" },
        query: { directory: "/other" },
      },
      { path: { id: "child-1" }, query: { directory: "/other" } },
    ]);
  });

  test.each([
    ["missing envelope data", "get", async () => ({ error: undefined })],
    ["malformed session", "get", async () => success({ id: "child-1" })],
    ["foreign returned session", "get", async () => success(session("other"))],
    [
      "foreign child parent",
      "children",
      async () => success([session("child-1", "other-parent")]),
    ],
    [
      "malformed status",
      "status",
      async () => success({ "child-1": { type: "other" } }),
    ],
    [
      "foreign message session",
      "messages",
      async () =>
        success([
          {
            info: { id: "message-1", role: "assistant", sessionID: "other" },
            parts: [],
          },
        ]),
    ],
    [
      "non-void prompt acknowledgement",
      "promptAsync",
      async () => success(true),
    ],
    ["false abort acknowledgement", "abort", async () => success(false)],
  ])("rejects %s", async (_label, operation, response) => {
    const adapter = new OpenCodeSessionAdapter(
      transport({ [operation]: response }),
      "/workspace"
    );
    const invocation = (() => {
      switch (operation) {
        case "children":
          return adapter.children("parent-1");
        case "status":
          return adapter.status();
        case "messages":
          return adapter.messages("child-1");
        case "promptAsync":
          return adapter.promptAsync({
            agent: "terra-max",
            messageID: VALID_OPENCODE_MESSAGE_ID,
            sessionID: "child-1",
            text: "Continue.",
          });
        case "abort":
          return adapter.abort("child-1");
        default:
          return adapter.get("child-1");
      }
    })();

    await expect(invocation).rejects.toBeInstanceOf(OpenCodeSessionError);
  });

  test("preserves safe SDK diagnostics without leaking unknown payload fields", async () => {
    const adapter = new OpenCodeSessionAdapter(
      transport({
        get: async () => ({
          data: undefined,
          error: {
            data: { message: "Worker was not found.", secret: "do-not-leak" },
            name: "NotFoundError",
            token: "also-secret",
          },
        }),
      }),
      "/workspace"
    );

    await expect(adapter.get("child-1")).rejects.toMatchObject({
      code: "OPENCODE_SESSION_NOT_FOUND",
      message: "session.get failed: Worker was not found.",
      operation: "session.get",
    });
    try {
      await adapter.get("child-1");
    } catch (error) {
      expect(String(error)).not.toContain("do-not-leak");
      expect(String(error)).not.toContain("also-secret");
    }
  });
});
