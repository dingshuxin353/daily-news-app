import { randomUUID } from "node:crypto";
import type { AgentCredentialService } from "../modules/agent-access/credential-service.js";
import { AgentAccessError } from "../modules/agent-access/credential-service.js";
import type { PostgresTenancyStore } from "../adapters/postgres/tenancy.js";
import { keyedDigest } from "../modules/identity/security.js";
import type {
  AgentRequestAction,
  AgentRequestContext,
  AgentRequestPolicyRepository,
} from "../modules/agent-access/request-policy.js";
import { AgentRequestError } from "../modules/agent-access/request-policy.js";

export interface AgentRequestAuthenticatorConfiguration {
  digestSecret: string;
  rateLimitRetentionHours: number;
  readTokenHourlyLimit: number;
  writeTokenHourlyLimit: number;
  readIpHourlyLimit: number;
  writeIpHourlyLimit: number;
  credentialLastUsedTouchSeconds: number;
}

export function createAgentRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

export class AgentRequestAuthenticator {
  constructor(
    private readonly credentials: AgentCredentialService,
    private readonly tenancy: PostgresTenancyStore,
    private readonly policy: AgentRequestPolicyRepository,
    private readonly config: AgentRequestAuthenticatorConfiguration,
  ) {}

  async authenticate(input: {
    authorization: unknown;
    clientIp: string;
    action: AgentRequestAction;
    requestId: string;
  }): Promise<AgentRequestContext> {
    try {
      const credential = await this.credentials.authenticateActiveToken(input.authorization);
      const tenant = await this.tenancy.resolveTenantContextForSpace(credential.spaceId);
      if (!tenant) {
        throw new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
      }
      await this.policy.reserveRequest({
        action: input.action,
        tokenDigest: keyedDigest(this.config.digestSecret, `api-token\0${credential.id}`),
        ipDigest: keyedDigest(this.config.digestSecret, `api-ip\0${input.clientIp}`),
        limits: {
          tokenHourlyLimit: input.action === "read"
            ? this.config.readTokenHourlyLimit
            : this.config.writeTokenHourlyLimit,
          ipHourlyLimit: input.action === "read"
            ? this.config.readIpHourlyLimit
            : this.config.writeIpHourlyLimit,
          retentionHours: this.config.rateLimitRetentionHours,
        },
      });
      await this.policy.touchCredentialLastUsed(
        credential.id,
        this.config.credentialLastUsedTouchSeconds,
      );
      return Object.freeze({
        requestId: input.requestId,
        credentialId: credential.id,
        credentialName: credential.name,
        tenant,
      });
    } catch (error) {
      if (error instanceof AgentRequestError) throw error;
      if (error instanceof AgentAccessError && error.status === 401) {
        throw new AgentRequestError(401, "invalid_token", "连接密钥无效或已失效。");
      }
      throw new AgentRequestError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
    }
  }
}
