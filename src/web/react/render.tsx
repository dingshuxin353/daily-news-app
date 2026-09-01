import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { CredentialRecord } from "../../modules/agent-access/credential-service.js";
import type { ReadingShell } from "../../modules/private-reading/service.js";
import {
  AgentConfirmPage,
  AgentSettingsPage,
  CredentialSecretPage,
  LoginPage,
  NicknameOnboardingPage,
  OnboardingPage,
  PublicPage,
} from "./pages.js";

function document(markup: ReactNode): string {
  return `<!doctype html>${renderToStaticMarkup(markup)}`;
}

export function renderPublicPage(input: { basePath: string; signedIn: boolean }): string {
  return document(<PublicPage {...input} />);
}

export function renderLoginPage(basePath: string, input: { returnTo?: string; returnLabel?: string } = {}): string {
  return document(<LoginPage basePath={basePath} {...input} />);
}

export function renderOnboardingPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; operationId: string; setupUrl: string }): string {
  return document(<OnboardingPage {...input} />);
}

export function renderNicknameOnboardingPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; nickname?: string; error?: string }): string {
  return document(<NicknameOnboardingPage {...input} />);
}

export function renderAgentSettingsPage(input: { basePath: string; shell: ReadingShell; credentials: CredentialRecord[]; csrfToken: string; operationId: string; activeLimit: number }): string {
  return document(<AgentSettingsPage {...input} />);
}

export function renderCredentialSecretPage(input: { basePath: string; shell: ReadingShell; token: string | null; title: string; returnPath?: string }): string {
  return document(<CredentialSecretPage {...input} />);
}

export function renderAgentConfirmPage(input: { basePath: string; shell: ReadingShell; title: string; description: string; action: string; csrfToken: string; submitLabel: string; hidden?: Record<string, string> }): string {
  return document(<AgentConfirmPage {...input} />);
}
