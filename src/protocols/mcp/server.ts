import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { AgentOperationsService } from "../../modules/agent-access/operations.js";
import type { AgentRequestContext } from "../../modules/agent-access/request-policy.js";
import { AgentRequestError } from "../../modules/agent-access/request-policy.js";
import {
  dailyContextOutputSchema,
  dailyIssueOutputSchema,
  dailySubmissionOutputSchema,
  createSubmitDailyCandidateInputSchema,
  createSubmitTodoCandidateInputSchema,
  emptyInputSchema,
  getDailyContextInputSchema,
  getDailyIssueInputSchema,
  todoContextOutputSchema,
  todoStateOutputSchema,
  todoSubmissionOutputSchema,
  createThemeInputSchema,
  deleteThemeInputSchema,
  getThemeInputSchema,
  themeContextOutputSchema,
  themeMutationOutputSchema,
  themeOutputSchema,
  updateThemeInputSchema,
} from "./schemas.js";

export const DAILYNEWS_MCP_INSTRUCTIONS = [
  "Read context before every write.",
  "Daily defaults may be read; writes need explicit publicationId and date.",
  "Do not mix Daily and Todo Candidates or set Space or formal state.",
  "Disabled Todo must be enabled in settings.",
  "Exact retries reuse clientRunId; changed intent uses a new ID.",
  "Historical and replace writes need explicit user confirmation.",
  "Theme writes require context/current first and declarative Schema only; never mutate official Themes or selections; no HTML, CSS, JavaScript, URLs, or layout.",
].join(" ");

const readAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const dailyWriteAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const todoWriteAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const themeWriteAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const themeDeleteAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export interface AgentMcpServerDependencies {
  operations: AgentOperationsService;
  dailyItemLimit: number;
  todoOperationLimit: number;
}

function accessFrom(authInfo: AuthInfo | undefined): AgentRequestContext {
  const access = authInfo?.extra?.access;
  if (!access || typeof access !== "object" || Array.isArray(access)) {
    throw new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
  }
  return access as AgentRequestContext;
}

function publicError(error: unknown): AgentRequestError {
  return error instanceof AgentRequestError
    ? error
    : new AgentRequestError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
}

async function runTool(
  access: AgentRequestContext,
  work: () => Promise<Record<string, unknown>>,
  summarize: (result: Record<string, unknown>) => string,
): Promise<CallToolResult> {
  try {
    const structuredContent = { ...(await work()), requestId: access.requestId };
    return {
      content: [{ type: "text", text: `${summarize(structuredContent)} (${access.requestId})` }],
      structuredContent,
    };
  } catch (error) {
    const mapped = publicError(error);
    const structuredContent = {
      error: {
        code: mapped.code,
        message: mapped.message,
        requestId: access.requestId,
        ...(mapped.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: mapped.retryAfterSeconds }),
      },
    };
    return {
      isError: true,
      content: [{ type: "text", text: `${mapped.code}: ${mapped.message} (${access.requestId})` }],
      structuredContent,
    };
  }
}

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function createAgentMcpHandler(dependencies: AgentMcpServerDependencies): McpHttpHandler {
  return createMcpHandler(({ authInfo }) => {
    const access = accessFrom(authInfo);
    const server = new McpServer({ name: "dailynews", version: "1.0.0" }, {
      instructions: DAILYNEWS_MCP_INSTRUCTIONS,
    });

    server.registerTool("get_daily_context", {
      title: "Get Daily context",
      description: "Resolve a Publication/date and return its write rules. Call before submitting Daily content.",
      inputSchema: getDailyContextInputSchema,
      outputSchema: dailyContextOutputSchema,
      annotations: readAnnotations,
    }, (input) => runTool(access, async () => {
      const listing = await dependencies.operations.listPublications(access);
      const publication = input.publicationId
        ? listing.publications.find((entry) => entry.publicationId === input.publicationId)
        : listing.publications.find((entry) => entry.isDefault) ?? (
          listing.publications.length === 1 ? listing.publications[0] : undefined
        );
      if (!publication) {
        throw new AgentRequestError(404, "target_not_found", "没有找到目标日报。");
      }
      const context = await dependencies.operations.getDailyContext(access, publication.publicationId, input.date);
      return { ...asRecord(context), availablePublications: listing.publications };
    }, (result) => {
      const target = result.publication as { publicationId?: unknown; writable?: unknown };
      return `Daily context: ${String(target.publicationId)} / ${String(result.resolvedDate)}; writable=${String(target.writable)}`;
    }));

    server.registerTool("submit_daily_candidate", {
      title: "Submit Daily Candidate",
      description: `Validate one Daily Candidate and update the formal Issue and Compiled Edition (maximum ${dependencies.dailyItemLimit} items). Read context and obtain required confirmations first.`,
      inputSchema: createSubmitDailyCandidateInputSchema(dependencies.dailyItemLimit),
      outputSchema: dailySubmissionOutputSchema,
      annotations: dailyWriteAnnotations,
    }, (input) => runTool(
      access,
      async () => asRecord(await dependencies.operations.submitDailyCandidate(access, input)),
      (result) => `Daily ${String(result.result)}: ${String(result.publicationId)} / ${String(result.date)} revision ${String(result.revision)}`,
    ));

    server.registerTool("get_daily_issue", {
      title: "Get formal Daily Issue",
      description: "Read one formal Issue and its Compiled Edition for the authenticated Space.",
      inputSchema: getDailyIssueInputSchema,
      outputSchema: dailyIssueOutputSchema,
      annotations: readAnnotations,
    }, (input) => runTool(
      access,
      async () => asRecord(await dependencies.operations.getDailyIssue(access, input.publicationId, input.date)),
      (result) => `Formal Daily Issue: ${String(result.publicationId)} / ${String(result.date)} revision ${String(result.revision)}`,
    ));

    server.registerTool("get_todo_context", {
      title: "Get Personal Todo context",
      description: "Check whether Personal Todo is enabled and read its Candidate limits and current revision.",
      inputSchema: emptyInputSchema,
      outputSchema: todoContextOutputSchema,
      annotations: readAnnotations,
    }, () => runTool(
      access,
      async () => asRecord(await dependencies.operations.getTodoContext(access)),
      (result) => `Personal Todo context: enabled=${String(result.enabled)}${result.revision === undefined ? "" : `; revision=${String(result.revision)}`}`,
    ));

    server.registerTool("submit_todo_candidate", {
      title: "Submit Todo Candidate",
      description: `Validate one Personal Todo Candidate and update the formal Todo State (maximum ${dependencies.todoOperationLimit} operations). Read context first.`,
      inputSchema: createSubmitTodoCandidateInputSchema(dependencies.todoOperationLimit),
      outputSchema: todoSubmissionOutputSchema,
      annotations: todoWriteAnnotations,
    }, (input) => runTool(
      access,
      async () => asRecord(await dependencies.operations.submitTodoCandidate(access, input)),
      (result) => `Personal Todo ${String(result.result)}: revision ${String(result.revision)}; operations=${String(result.operationCount)}`,
    ));

    server.registerTool("get_todo_state", {
      title: "Get formal Personal Todo State",
      description: "Read the formal Personal Todo State. Returns todo_disabled when the user has not enabled it.",
      inputSchema: emptyInputSchema,
      outputSchema: todoStateOutputSchema,
      annotations: readAnnotations,
    }, () => runTool(
      access,
      async () => asRecord(await dependencies.operations.getTodoState(access)),
      (result) => `Formal Personal Todo State: revision ${String(result.revision)}`,
    ));

    server.registerTool("get_theme_context", {
      title: "Get Theme context",
      description: "Read Theme Schema constraints, official and custom Themes, current revisions, and usage relationships.",
      inputSchema: emptyInputSchema,
      outputSchema: themeContextOutputSchema,
      annotations: readAnnotations,
    }, () => runTool(
      access,
      async () => asRecord(await dependencies.operations.getThemeContext(access)),
      (result) => `Theme context: ${String((result.themes as unknown[])?.length ?? 0)} visible Themes`,
    ));

    server.registerTool("get_theme", {
      title: "Get Theme",
      description: "Read one visible official or custom Theme definition, current revision, and usage relationships.",
      inputSchema: getThemeInputSchema,
      outputSchema: themeOutputSchema,
      annotations: readAnnotations,
    }, (input) => runTool(
      access,
      async () => asRecord(await dependencies.operations.getTheme(access, input.themeId)),
      (result) => `Theme ${String(result.themeId)} revision ${String(result.revision)}`,
    ));

    server.registerTool("create_theme", {
      title: "Create custom Theme",
      description: "Validate and compile a declarative Theme, then atomically save its first revision. Does not change browser Theme selections.",
      inputSchema: createThemeInputSchema,
      outputSchema: themeMutationOutputSchema,
      annotations: themeWriteAnnotations,
    }, (input) => runTool(
      access,
      async () => asRecord(await dependencies.operations.createTheme(access, input)),
      (result) => `Theme ${String(result.result)}: ${String(result.themeId)} revision ${String(result.revision)}`,
    ));

    server.registerTool("update_theme", {
      title: "Update custom Theme",
      description: "Validate and compile a custom Theme using baseRevision, then atomically advance its current revision.",
      inputSchema: updateThemeInputSchema,
      outputSchema: themeMutationOutputSchema,
      annotations: themeWriteAnnotations,
    }, (input) => runTool(
      access,
      async () => asRecord(await dependencies.operations.updateTheme(access, input)),
      (result) => `Theme ${String(result.result)}: ${String(result.themeId)} revision ${String(result.revision)}`,
    ));

    server.registerTool("delete_theme", {
      title: "Delete custom Theme",
      description: "Remove an unused custom Theme from the current catalog using baseRevision while preserving historical revisions.",
      inputSchema: deleteThemeInputSchema,
      outputSchema: themeMutationOutputSchema,
      annotations: themeDeleteAnnotations,
    }, (input) => runTool(
      access,
      async () => asRecord(await dependencies.operations.deleteTheme(access, input)),
      (result) => `Theme deleted: ${String(result.themeId)} revision ${String(result.revision)}`,
    ));

    return server;
  }, {
    legacy: "stateless",
  });
}

export function createAgentMcpAuthInfo(access: AgentRequestContext): AuthInfo {
  return {
    token: "validated-dailynews-pat",
    clientId: access.credentialId,
    scopes: ["dailynews:read", "dailynews:write"],
    extra: { access },
  };
}
