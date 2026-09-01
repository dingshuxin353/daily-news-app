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
import { DailyPage, HomePage, PublicationsPage, TodoPage } from "./reading-pages.js";
import type { DailyReading, PublicationReadingSummary } from "../../modules/private-reading/service.js";
import type { UserProfile } from "../../modules/identity/profile-service.js";
import type { ManagedPublication, SiteManagementSnapshot } from "../../modules/site-management/service.js";
import type { BrowserTheme } from "../../modules/site-management/theme-catalog.js";
import {
  AccountSettingsPage,
  AdvancedAccessPage,
  HomeSettingsPage,
  PublicationFormPage,
  PublicationLimitPage,
  SettingsConfirmPage,
  SitesPage,
  ThemeCatalogPage,
} from "./settings-pages.js";

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

export function renderHomePage(input: { basePath: string; shell: ReadingShell; daily: DailyReading | null; publications?: PublicationReadingSummary[]; todoProjection?: any }): string {
  return document(<HomePage {...input} publications={input.publications ?? []} />);
}

export function renderPublicationsPage(input: { basePath: string; shell: ReadingShell; publications: PublicationReadingSummary[] }): string {
  return document(<PublicationsPage {...input} />);
}

export function renderDailyPage(input: { basePath: string; shell: ReadingShell; daily: DailyReading | null; dates?: string[]; requestedDate?: string }): string {
  return document(<DailyPage {...input} />);
}

export function renderTodoPage(input: { basePath: string; shell: ReadingShell; projection: any }): string {
  return document(<TodoPage {...input} />);
}

export function renderSitesPage(input: { basePath: string; shell: ReadingShell; snapshot: SiteManagementSnapshot; csrfToken: string; publicationLimit: number; themes: BrowserTheme[]; reason?: string; updated?: string; created?: ManagedPublication }): string {
  return document(<SitesPage {...input} />);
}

export function renderHomeSettingsPage(input: { basePath: string; shell: ReadingShell; snapshot: SiteManagementSnapshot; themes: BrowserTheme[]; csrfToken: string; name?: string; themeId?: string; error?: string; saved?: boolean }): string {
  return document(<HomeSettingsPage {...input} />);
}

export function renderPublicationFormPage(input: { basePath: string; shell: ReadingShell; themes: BrowserTheme[]; csrfToken: string; mode: "new" | "edit"; publication?: ManagedPublication; name?: string; publicationId?: string; theme?: { mode: "inherit" } | { mode: "override"; themeId: string }; error?: string; saved?: boolean }): string {
  return document(<PublicationFormPage {...input} />);
}

export function renderPublicationLimitPage(input: { basePath: string; shell: ReadingShell; publicationLimit: number }): string {
  return document(<PublicationLimitPage {...input} />);
}

export function renderThemeCatalogPage(input: { basePath: string; shell: ReadingShell; themes: BrowserTheme[] }): string {
  return document(<ThemeCatalogPage {...input} />);
}

export function renderAccountSettingsPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; profile: UserProfile; nickname?: string; error?: string; saved?: boolean }): string {
  return document(<AccountSettingsPage {...input} />);
}

export function renderAdvancedAccessPage(input: { basePath: string; shell: ReadingShell; apiBaseUrl: string; mcpUrl: string }): string {
  return document(<AdvancedAccessPage {...input} />);
}

export function renderSettingsConfirmPage(input: { basePath: string; shell: ReadingShell; title: string; description: string; action: string; csrfToken: string; submitLabel: string; hidden?: Record<string, string>; cancelPath: string; cancelLabel?: string }): string {
  return document(<SettingsConfirmPage {...input} />);
}

export { parseTodoAnchorHash } from "./reading-interactions.js";
