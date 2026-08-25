import { randomUUID } from "node:crypto";
import tencentcloud from "tencentcloud-sdk-nodejs-ses";
import type { TencentSesRuntimeConfig } from "../../cloud/config.js";

export interface LoginMailMessage {
  email: string;
  otp: string;
  expiresInMinutes: number;
}

export interface MailDeliveryResult {
  requestId: string;
  messageId: string;
}

export interface LoginMailAdapter {
  send(message: LoginMailMessage): Promise<MailDeliveryResult>;
}

export interface FakeMailMessage extends LoginMailMessage, MailDeliveryResult {
  sentAt: Date;
}

export class FakeMailAdapter implements LoginMailAdapter {
  readonly mode = "fake";
  private readonly messages: FakeMailMessage[] = [];
  private failure: Error | null = null;

  async send(message: LoginMailMessage): Promise<MailDeliveryResult> {
    if (this.failure) throw this.failure;
    const result = {
      requestId: `fake-request-${randomUUID()}`,
      messageId: `fake-message-${randomUUID()}`,
    };
    this.messages.push({ ...message, ...result, sentAt: new Date() });
    return result;
  }

  latestFor(email: string): FakeMailMessage | null {
    return [...this.messages].reverse().find((message) => message.email === email) ?? null;
  }

  failWith(error: Error | null): void {
    this.failure = error;
  }

  clear(): void {
    this.messages.length = 0;
    this.failure = null;
  }
}

interface TencentSesClient {
  SendEmail(input: {
    FromEmailAddress: string;
    Destination: string[];
    Subject: string;
    TriggerType: number;
    Template: { TemplateID: number; TemplateData: string };
  }): Promise<{ RequestId?: string; MessageId?: string }>;
}

export class TencentSesMailAdapter implements LoginMailAdapter {
  readonly mode = "ses";
  private readonly client: TencentSesClient;

  constructor(
    private readonly config: TencentSesRuntimeConfig,
    client?: TencentSesClient,
  ) {
    if (client) {
      this.client = client;
      return;
    }
    const Client = tencentcloud.ses.v20201002.Client;
    this.client = new Client({
      credential: { secretId: config.secretId, secretKey: config.secretKey },
      region: config.region,
      profile: {
        httpProfile: {
          endpoint: "ses.tencentcloudapi.com",
          reqTimeout: 15,
        },
      },
    });
  }

  async send(message: LoginMailMessage): Promise<MailDeliveryResult> {
    const response = await this.client.SendEmail({
      FromEmailAddress: this.config.fromEmailAddress,
      Destination: [message.email],
      Subject: this.config.subject,
      TriggerType: 1,
      Template: {
        TemplateID: this.config.templateId,
        TemplateData: JSON.stringify({ code: message.otp, minutes: String(message.expiresInMinutes) }),
      },
    });
    if (!response.RequestId || !response.MessageId) {
      throw new Error("SES response did not contain delivery identifiers");
    }
    return { requestId: response.RequestId, messageId: response.MessageId };
  }
}
