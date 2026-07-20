import { z } from "zod";

import { ExternalIdSchema } from "./schema/common.js";

const SessionTimeSchema = z
  .object({
    compacting: z.number().finite().optional(),
    created: z.number().finite(),
    updated: z.number().finite(),
  })
  .strict();

export const OpenCodePermissionRuleSchema = z
  .object({
    action: z.enum(["allow", "deny", "ask"]),
    pattern: z.string().trim().min(1),
    permission: z.string().trim().min(1),
  })
  .strict();

const OpenCodeRevertStateSchema = z
  .object({
    diff: z.string().optional(),
    messageID: ExternalIdSchema,
    partID: ExternalIdSchema.optional(),
    snapshot: z.string().min(1).optional(),
  })
  .passthrough();

export const OpenCodeSessionSchema = z
  .object({
    directory: z.string().min(1),
    id: ExternalIdSchema,
    parentID: ExternalIdSchema.optional(),
    permission: z.array(OpenCodePermissionRuleSchema).optional(),
    projectID: ExternalIdSchema,
    revert: OpenCodeRevertStateSchema.optional(),
    time: SessionTimeSchema,
    title: z.string(),
    version: z.string().min(1),
  })
  .passthrough();

export const OpenCodeSessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }).strict(),
  z.object({ type: z.literal("busy") }).strict(),
  z
    .object({
      action: z
        .object({
          label: z.string().trim().min(1).max(1000),
          link: z.string().trim().min(1).max(4000).optional(),
          message: z.string().trim().min(1).max(4000),
          provider: z.string().trim().min(1).max(512),
          reason: z.string().trim().min(1).max(512),
          title: z.string().trim().min(1).max(1000),
        })
        .strict()
        .optional(),
      attempt: z.int().nonnegative(),
      message: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .transform((message) =>
          message
            .replace(
              /\s*Please include the request ID [0-9a-z-]+ in your message\.?/giu,
              ""
            )
            .slice(0, 1000)
        )
        .pipe(z.string().trim().min(1)),
      next: z.number().finite(),
      type: z.literal("retry"),
    })
    .strict(),
]);

export const OpenCodeSessionStatusMapSchema = z.record(
  ExternalIdSchema,
  OpenCodeSessionStatusSchema
);

const MessageInfoSchema = z
  .object({
    id: ExternalIdSchema,
    role: z.enum(["user", "assistant"]),
    sessionID: ExternalIdSchema,
  })
  .passthrough();

const MessagePartSchema = z
  .object({
    id: ExternalIdSchema,
    ignored: z.boolean().optional(),
    messageID: ExternalIdSchema,
    sessionID: ExternalIdSchema,
    text: z.string().optional(),
    type: z.string().min(1),
  })
  .passthrough()
  .refine((part) => part.type !== "text" || part.text !== undefined, {
    error: "OpenCode text message parts require text.",
  });

export const OpenCodeMessageRecordSchema = z
  .object({
    info: MessageInfoSchema,
    parts: z.array(MessagePartSchema),
  })
  .strict();

const LEADING_DOT_SEGMENTS = /^(\.\/)+/u;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//u;

const normalizeDiffPath = (path: string): string =>
  path.replaceAll("\\", "/").replace(LEADING_DOT_SEGMENTS, "");

const NormalizedDiffPathSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((path, context) => {
    const normalized = normalizeDiffPath(path);
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      WINDOWS_DRIVE_ABSOLUTE.test(normalized) ||
      normalized.split("/").some((segment) => segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "OpenCode diff paths must be repository-relative.",
      });
    }
  })
  .transform(normalizeDiffPath);

export const OpenCodeFileDiffSchema = z
  .object({
    additions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
    file: NormalizedDiffPathSchema,
    patch: z.string(),
    status: z.enum(["added", "modified", "deleted"]),
  })
  .strict()
  .transform(({ file, ...diff }) => ({ ...diff, path: file }));

export const OpenCodePermissionRequestSchema = z
  .object({
    always: z.array(z.string()),
    id: ExternalIdSchema,
    metadata: z.record(z.string(), z.unknown()),
    patterns: z.array(z.string().min(1)),
    permission: z.string().min(1),
    sessionID: ExternalIdSchema,
    tool: z
      .object({
        callID: ExternalIdSchema,
        messageID: ExternalIdSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const NamedSdkErrorSchema = z
  .object({
    data: z
      .object({
        message: z.string().transform((message) => message.slice(0, 1000)),
      })
      .passthrough(),
    name: z.string().min(1),
  })
  .passthrough();

const TaggedSdkErrorSchema = z
  .object({
    _tag: z.string().min(1),
    message: z.string().transform((message) => message.slice(0, 1000)),
  })
  .passthrough();

const OpenCodeMessageIDSchema = ExternalIdSchema.regex(
  /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u,
  "OpenCode prompt message IDs must use the sortable native message ID shape."
);

const PromptInputSchema = z
  .object({
    agent: z.string().trim().min(1).max(512),
    directory: z.string().min(1).optional(),
    messageID: OpenCodeMessageIDSchema,
    sessionID: ExternalIdSchema,
    text: z.string().min(1).max(100_000),
  })
  .strict();

const CreateChildInputSchema = z
  .object({
    directory: z.string().min(1).optional(),
    parentID: ExternalIdSchema,
    title: z.string().trim().min(1).max(512),
  })
  .strict();

const PermissionReplyInputSchema = z.discriminatedUnion("reply", [
  z
    .object({
      directory: z.string().min(1).optional(),
      feedback: z.never().optional(),
      reply: z.literal("once"),
      requestID: ExternalIdSchema,
    })
    .strict(),
  z
    .object({
      directory: z.string().min(1).optional(),
      feedback: z.string().trim().min(1).max(4000).optional(),
      reply: z.literal("reject"),
      requestID: ExternalIdSchema,
    })
    .strict(),
]);

const RevertInputSchema = z
  .object({
    directory: z.string().min(1).optional(),
    messageID: ExternalIdSchema,
    partID: ExternalIdSchema.optional(),
    sessionID: ExternalIdSchema,
  })
  .strict();

type SessionRequest = {
  path: { id: string };
  query: { directory: string };
};

type CreateSessionRequest = {
  body: { parentID: string; title: string };
  query: { directory: string };
};

type PromptRequest = SessionRequest & {
  body: {
    agent: string;
    messageID: string;
    parts: Array<{ text: string; type: "text" }>;
  };
};

type MessageRequest = SessionRequest & {
  path: { id: string; messageID: string };
};

type DiffRequest = SessionRequest & {
  query: { directory: string; messageID?: string };
};

type PermissionUpdateRequest = SessionRequest & {
  body: { permission: OpenCodePermissionRule[] };
};

type RevertRequest = SessionRequest & {
  body: { messageID: string; partID?: string };
};

type PermissionReplyRequest = {
  body: { message?: string; reply: "once" | "reject" };
  path: { requestID: string };
  query: { directory: string };
};

export type OpenCodeSessionTransport = {
  abort: (input: SessionRequest) => Promise<unknown>;
  children: (input: SessionRequest) => Promise<unknown>;
  create: (input: CreateSessionRequest) => Promise<unknown>;
  delete: (input: SessionRequest) => Promise<unknown>;
  diff: (input: DiffRequest) => Promise<unknown>;
  get: (input: SessionRequest) => Promise<unknown>;
  message: (input: MessageRequest) => Promise<unknown>;
  messages: (input: SessionRequest) => Promise<unknown>;
  promptAsync: (input: PromptRequest) => Promise<unknown>;
  revert: (input: RevertRequest) => Promise<unknown>;
  status: (input: { query: { directory: string } }) => Promise<unknown>;
  unrevert: (input: SessionRequest) => Promise<unknown>;
  update: (input: PermissionUpdateRequest) => Promise<unknown>;
};

export type OpenCodePermissionTransport = {
  reply: (input: PermissionReplyRequest) => Promise<unknown>;
};

export type OpenCodeSession = z.infer<typeof OpenCodeSessionSchema>;
export type OpenCodeSessionStatus = z.infer<typeof OpenCodeSessionStatusSchema>;
export type OpenCodeMessageRecord = z.infer<typeof OpenCodeMessageRecordSchema>;
export type OpenCodeFileDiff = z.output<typeof OpenCodeFileDiffSchema>;
export type OpenCodePermissionRequest = z.infer<
  typeof OpenCodePermissionRequestSchema
>;
export type OpenCodePermissionRule = z.infer<
  typeof OpenCodePermissionRuleSchema
>;

export class OpenCodeSessionError extends Error {
  readonly code: string;
  readonly operation: string;

  constructor(code: string, operation: string, message: string) {
    super(message);
    this.name = "OpenCodeSessionError";
    this.code = code;
    this.operation = operation;
  }
}

const malformedResponse = (operation: string): OpenCodeSessionError =>
  new OpenCodeSessionError(
    "OPENCODE_RESPONSE_INVALID",
    operation,
    `${operation} returned malformed response data.`
  );

const sdkFailure = (
  operation: string,
  error: unknown
): OpenCodeSessionError => {
  const named = NamedSdkErrorSchema.safeParse(error);
  const tagged = TaggedSdkErrorSchema.safeParse(error);
  let name: string | undefined;
  let message = "OpenCode returned an unrecognized error.";
  if (named.success) {
    name = named.data.name;
    message = named.data.data.message;
  } else if (tagged.success) {
    name = tagged.data._tag;
    message = tagged.data.message;
  }
  const code = (() => {
    if (name === "SessionBusyError") {
      return "OPENCODE_SESSION_BUSY";
    }
    if (name === "PermissionNotFoundError") {
      return "OPENCODE_PERMISSION_NOT_FOUND";
    }
    if (name === "NotFoundError") {
      return operation.startsWith("permission.")
        ? "OPENCODE_PERMISSION_NOT_FOUND"
        : "OPENCODE_SESSION_NOT_FOUND";
    }
    return "OPENCODE_SDK_ERROR";
  })();
  return new OpenCodeSessionError(
    code,
    operation,
    `${operation} failed: ${message}`
  );
};

const responseData = <Schema extends z.ZodType>(
  response: unknown,
  operation: string,
  schema: Schema
): z.output<Schema> => {
  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response)
  ) {
    throw malformedResponse(operation);
  }
  if ("error" in response && response.error !== undefined) {
    throw sdkFailure(operation, response.error);
  }
  if (!("data" in response)) {
    throw malformedResponse(operation);
  }
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) {
    throw malformedResponse(operation);
  }
  return parsed.data;
};

export class OpenCodeSessionAdapter {
  readonly #transport: OpenCodeSessionTransport;
  readonly #directory: string;
  readonly #permissionTransport?: OpenCodePermissionTransport;

  constructor(
    transport: OpenCodeSessionTransport,
    directory: string,
    permissionTransport?: OpenCodePermissionTransport
  ) {
    if (typeof transport !== "object" || transport === null) {
      throw new OpenCodeSessionError(
        "OPENCODE_TRANSPORT_INVALID",
        "session.adapter",
        "OpenCode session transport must be an object."
      );
    }
    for (const operation of [
      "abort",
      "children",
      "create",
      "delete",
      "diff",
      "get",
      "message",
      "messages",
      "promptAsync",
      "revert",
      "status",
      "unrevert",
      "update",
    ] as const) {
      if (typeof transport[operation] !== "function") {
        throw new OpenCodeSessionError(
          "OPENCODE_TRANSPORT_INVALID",
          "session.adapter",
          `OpenCode session transport is missing ${operation}.`
        );
      }
    }
    if (
      permissionTransport !== undefined &&
      (typeof permissionTransport !== "object" ||
        permissionTransport === null ||
        typeof permissionTransport.reply !== "function")
    ) {
      throw new OpenCodeSessionError(
        "OPENCODE_TRANSPORT_INVALID",
        "session.adapter",
        "OpenCode permission transport is invalid."
      );
    }
    if (directory.length === 0) {
      throw new OpenCodeSessionError(
        "OPENCODE_DIRECTORY_INVALID",
        "session.adapter",
        "OpenCode session directory must be non-empty."
      );
    }
    this.#transport = transport;
    this.#directory = directory;
    this.#permissionTransport = permissionTransport;
  }

  async get(sessionID: string, directory?: string): Promise<OpenCodeSession> {
    const id = ExternalIdSchema.parse(sessionID);
    const data = responseData(
      await this.#transport.get(this.#request(id, directory)),
      "session.get",
      OpenCodeSessionSchema
    );
    if (data.id !== id) {
      throw new OpenCodeSessionError(
        "OPENCODE_SESSION_ID_MISMATCH",
        "session.get",
        `session.get returned ${data.id} for requested session ${id}.`
      );
    }
    return data;
  }

  async createChild(
    input: z.input<typeof CreateChildInputSchema>
  ): Promise<OpenCodeSession> {
    const parsed = CreateChildInputSchema.parse(input);
    const session = responseData(
      await this.#transport.create({
        body: { parentID: parsed.parentID, title: parsed.title },
        query: { directory: parsed.directory ?? this.#directory },
      }),
      "session.create",
      OpenCodeSessionSchema
    );
    if (session.parentID !== parsed.parentID) {
      throw new OpenCodeSessionError(
        "OPENCODE_SESSION_PARENT_MISMATCH",
        "session.create",
        `Created session ${session.id} is not a child of requested parent ${parsed.parentID}.`
      );
    }
    return session;
  }

  async remove(sessionID: string, directory?: string): Promise<void> {
    const id = ExternalIdSchema.parse(sessionID);
    responseData(
      await this.#transport.delete(this.#request(id, directory)),
      "session.delete",
      z.literal(true)
    );
  }

  async children(
    parentID: string,
    directory?: string
  ): Promise<OpenCodeSession[]> {
    const parent = ExternalIdSchema.parse(parentID);
    const data = responseData(
      await this.#transport.children(this.#request(parent, directory)),
      "session.children",
      z.array(OpenCodeSessionSchema)
    );
    const childIDs = new Set<string>();
    for (const child of data) {
      if (child.parentID !== parent) {
        throw new OpenCodeSessionError(
          "OPENCODE_SESSION_PARENT_MISMATCH",
          "session.children",
          `Session ${child.id} is not a child of requested parent ${parent}.`
        );
      }
      if (childIDs.has(child.id)) {
        throw new OpenCodeSessionError(
          "OPENCODE_SESSION_DUPLICATE_CHILD",
          "session.children",
          `session.children returned duplicate child ${child.id}.`
        );
      }
      childIDs.add(child.id);
    }
    return data;
  }

  async status(
    directory?: string
  ): Promise<Record<string, OpenCodeSessionStatus>> {
    return responseData(
      await this.#transport.status({
        query: { directory: directory ?? this.#directory },
      }),
      "session.status",
      OpenCodeSessionStatusMapSchema
    );
  }

  async messages(
    sessionID: string,
    directory?: string
  ): Promise<OpenCodeMessageRecord[]> {
    const id = ExternalIdSchema.parse(sessionID);
    const data = responseData(
      await this.#transport.messages(this.#request(id, directory)),
      "session.messages",
      z.array(OpenCodeMessageRecordSchema)
    );
    for (const message of data) {
      this.#validateMessage(message, id, undefined, "session.messages");
    }
    return data;
  }

  async message(
    sessionID: string,
    messageID: string,
    directory?: string
  ): Promise<OpenCodeMessageRecord> {
    const id = ExternalIdSchema.parse(sessionID);
    const requestedMessageID = ExternalIdSchema.parse(messageID);
    const data = responseData(
      await this.#transport.message({
        path: { id, messageID: requestedMessageID },
        query: { directory: directory ?? this.#directory },
      }),
      "session.message",
      OpenCodeMessageRecordSchema
    );
    this.#validateMessage(data, id, requestedMessageID, "session.message");
    return data;
  }

  async diff(
    sessionID: string,
    messageID?: string,
    directory?: string
  ): Promise<OpenCodeFileDiff[]> {
    const id = ExternalIdSchema.parse(sessionID);
    const requestedMessageID =
      messageID === undefined ? undefined : ExternalIdSchema.parse(messageID);
    return responseData(
      await this.#transport.diff({
        path: { id },
        query: {
          directory: directory ?? this.#directory,
          ...(requestedMessageID === undefined
            ? {}
            : { messageID: requestedMessageID }),
        },
      }),
      "session.diff",
      z.array(OpenCodeFileDiffSchema)
    );
  }

  async appendPermissions(
    sessionID: string,
    rules: OpenCodePermissionRule[],
    directory?: string
  ): Promise<OpenCodeSession> {
    const id = ExternalIdSchema.parse(sessionID);
    const parsedRules = z
      .array(OpenCodePermissionRuleSchema)
      .min(1)
      .parse(rules);
    const targetDirectory = directory ?? this.#directory;
    const current = await this.get(id, targetDirectory);
    const permission = [...(current.permission ?? []), ...parsedRules];
    const updated = responseData(
      await this.#transport.update({
        body: { permission: parsedRules },
        path: { id },
        query: { directory: targetDirectory },
      }),
      "session.update",
      OpenCodeSessionSchema
    );
    if (updated.id !== id) {
      throw new OpenCodeSessionError(
        "OPENCODE_SESSION_ID_MISMATCH",
        "session.update",
        `session.update returned ${updated.id} for requested session ${id}.`
      );
    }
    if (JSON.stringify(updated.permission) !== JSON.stringify(permission)) {
      throw new OpenCodeSessionError(
        "OPENCODE_PERMISSION_UPDATE_MISMATCH",
        "session.update",
        "session.update did not preserve the requested permission rule order."
      );
    }
    return updated;
  }

  async replyPermission(
    input: z.input<typeof PermissionReplyInputSchema>
  ): Promise<void> {
    const parsed = PermissionReplyInputSchema.parse(input);
    const transport = this.#requirePermissionTransport();
    responseData(
      await transport.reply({
        body: {
          ...(parsed.reply === "reject" && parsed.feedback !== undefined
            ? { message: parsed.feedback }
            : {}),
          reply: parsed.reply,
        },
        path: { requestID: parsed.requestID },
        query: { directory: parsed.directory ?? this.#directory },
      }),
      "permission.reply",
      z.literal(true)
    );
  }

  async revert(
    input: z.input<typeof RevertInputSchema>
  ): Promise<OpenCodeSession> {
    const parsed = RevertInputSchema.parse(input);
    const session = responseData(
      await this.#transport.revert({
        body: {
          messageID: parsed.messageID,
          ...(parsed.partID === undefined ? {} : { partID: parsed.partID }),
        },
        path: { id: parsed.sessionID },
        query: { directory: parsed.directory ?? this.#directory },
      }),
      "session.revert",
      OpenCodeSessionSchema
    );
    if (session.id !== parsed.sessionID) {
      throw new OpenCodeSessionError(
        "OPENCODE_SESSION_ID_MISMATCH",
        "session.revert",
        `session.revert returned ${session.id} for requested session ${parsed.sessionID}.`
      );
    }
    if (
      session.revert?.messageID !== parsed.messageID ||
      session.revert.partID !== parsed.partID
    ) {
      throw new OpenCodeSessionError(
        "OPENCODE_REVERT_BOUNDARY_MISMATCH",
        "session.revert",
        "session.revert did not retain the requested message boundary."
      );
    }
    return session;
  }

  async unrevert(
    sessionID: string,
    directory?: string
  ): Promise<OpenCodeSession> {
    const id = ExternalIdSchema.parse(sessionID);
    const session = responseData(
      await this.#transport.unrevert(this.#request(id, directory)),
      "session.unrevert",
      OpenCodeSessionSchema
    );
    if (session.id !== id) {
      throw new OpenCodeSessionError(
        "OPENCODE_SESSION_ID_MISMATCH",
        "session.unrevert",
        `session.unrevert returned ${session.id} for requested session ${id}.`
      );
    }
    if (session.revert !== undefined) {
      throw new OpenCodeSessionError(
        "OPENCODE_UNREVERT_STATE_MISMATCH",
        "session.unrevert",
        "session.unrevert returned a session with an active revert."
      );
    }
    return session;
  }

  async promptAsync(input: z.input<typeof PromptInputSchema>): Promise<void> {
    const parsed = PromptInputSchema.parse(input);
    responseData(
      await this.#transport.promptAsync({
        body: {
          agent: parsed.agent,
          messageID: parsed.messageID,
          parts: [{ text: parsed.text, type: "text" }],
        },
        path: { id: parsed.sessionID },
        query: { directory: parsed.directory ?? this.#directory },
      }),
      "session.promptAsync",
      z.object({}).strict()
    );
  }

  async abort(sessionID: string, directory?: string): Promise<void> {
    const id = ExternalIdSchema.parse(sessionID);
    responseData(
      await this.#transport.abort(this.#request(id, directory)),
      "session.abort",
      z.literal(true)
    );
  }

  #validateMessage(
    message: OpenCodeMessageRecord,
    sessionID: string,
    messageID: string | undefined,
    operation: string
  ): void {
    if (message.info.sessionID !== sessionID) {
      throw new OpenCodeSessionError(
        "OPENCODE_MESSAGE_SESSION_MISMATCH",
        operation,
        `Message ${message.info.id} belongs to a different session.`
      );
    }
    if (messageID !== undefined && message.info.id !== messageID) {
      throw new OpenCodeSessionError(
        "OPENCODE_MESSAGE_ID_MISMATCH",
        operation,
        `OpenCode returned message ${message.info.id} for requested message ${messageID}.`
      );
    }
    for (const part of message.parts) {
      if (part.sessionID !== sessionID || part.messageID !== message.info.id) {
        throw new OpenCodeSessionError(
          "OPENCODE_MESSAGE_PART_MISMATCH",
          operation,
          `Message part ${part.id} does not belong to message ${message.info.id}.`
        );
      }
    }
  }

  #requirePermissionTransport(): OpenCodePermissionTransport {
    if (this.#permissionTransport === undefined) {
      throw new OpenCodeSessionError(
        "OPENCODE_TRANSPORT_INVALID",
        "permission.transport",
        "OpenCode permission transport is unavailable."
      );
    }
    return this.#permissionTransport;
  }

  #request(sessionID: string, directory?: string): SessionRequest {
    return {
      path: { id: sessionID },
      query: { directory: directory ?? this.#directory },
    };
  }
}

type UnknownOperation = (input: unknown) => Promise<unknown>;

const bindOperation = (
  owner: object,
  operation: string,
  transportName: string
): UnknownOperation => {
  const candidate: unknown = Reflect.get(owner, operation);
  if (typeof candidate !== "function") {
    throw new OpenCodeSessionError(
      "OPENCODE_TRANSPORT_INVALID",
      "session.adapter",
      `${transportName} is missing ${operation}.`
    );
  }
  return async (input: unknown): Promise<unknown> => {
    const result: unknown = Reflect.apply(candidate, owner, [input]);
    return await Promise.resolve(result);
  };
};

const currentPermissionTransport = (
  client: object
): OpenCodePermissionTransport => {
  const lowLevelClient: unknown = Reflect.get(client, "_client");
  if (typeof lowLevelClient !== "object" || lowLevelClient === null) {
    throw new OpenCodeSessionError(
      "OPENCODE_TRANSPORT_INVALID",
      "session.adapter",
      "OpenCode client is missing its generated low-level transport."
    );
  }
  const post = bindOperation(
    lowLevelClient,
    "post",
    "OpenCode low-level transport"
  );
  return {
    reply: async (input) =>
      await post({
        ...input,
        headers: { "Content-Type": "application/json" },
        url: "/permission/{requestID}/reply",
      }),
  };
};

const sessionTransport = (candidate: unknown): OpenCodeSessionTransport => {
  if (typeof candidate !== "object" || candidate === null) {
    throw new OpenCodeSessionError(
      "OPENCODE_TRANSPORT_INVALID",
      "session.adapter",
      "OpenCode client is missing its session transport."
    );
  }
  return {
    abort: bindOperation(candidate, "abort", "OpenCode session transport"),
    children: bindOperation(
      candidate,
      "children",
      "OpenCode session transport"
    ),
    create: bindOperation(candidate, "create", "OpenCode session transport"),
    delete: bindOperation(candidate, "delete", "OpenCode session transport"),
    diff: bindOperation(candidate, "diff", "OpenCode session transport"),
    get: bindOperation(candidate, "get", "OpenCode session transport"),
    message: bindOperation(candidate, "message", "OpenCode session transport"),
    messages: bindOperation(
      candidate,
      "messages",
      "OpenCode session transport"
    ),
    promptAsync: bindOperation(
      candidate,
      "promptAsync",
      "OpenCode session transport"
    ),
    revert: bindOperation(candidate, "revert", "OpenCode session transport"),
    status: bindOperation(candidate, "status", "OpenCode session transport"),
    unrevert: bindOperation(
      candidate,
      "unrevert",
      "OpenCode session transport"
    ),
    update: bindOperation(candidate, "update", "OpenCode session transport"),
  };
};

export const createOpenCodeSessionAdapter = (
  client: object & { session: unknown },
  directory: string
): OpenCodeSessionAdapter =>
  new OpenCodeSessionAdapter(
    sessionTransport(client.session),
    directory,
    currentPermissionTransport(client)
  );
