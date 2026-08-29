import type { CloudFileConfig } from "../../cloud/config.js";
import type { TenantContext } from "../../adapters/postgres/tenancy.js";
import { requireTenantContext } from "../../adapters/postgres/tenancy.js";

const PUBLICATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type SiteManagementErrorCode =
  | "SITE_INPUT_INVALID"
  | "SITE_NAME_CONFLICT"
  | "SITE_ID_CONFLICT"
  | "SITE_LIMIT_REACHED"
  | "SITE_TARGET_NOT_FOUND"
  | "SITE_LAST_ACTIVE"
  | "SITE_THEME_NOT_FOUND"
  | "SITE_STORAGE_FAILED";

export class SiteManagementError extends Error {
  constructor(
    readonly code: SiteManagementErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SiteManagementError";
  }
}

export interface ManagedPublication {
  publicationId: string;
  name: string;
  status: "active" | "inactive";
  sortOrder: number | null;
  isPrimary: boolean;
  theme: { mode: "inherit" } | { mode: "override"; themeId: string };
}

export interface SiteManagementSnapshot {
  home: { name: string; themeId: string };
  publications: ManagedPublication[];
  todo: { enabled: boolean; hasFormalData: boolean };
}

export interface SiteManagementRepository {
  readSnapshot(tenant: TenantContext): Promise<SiteManagementSnapshot>;
  createPublication(tenant: TenantContext, input: {
    publicationId: string;
    name: string;
    theme: { mode: "inherit" } | { mode: "override"; themeId: string };
    timeZone: string;
    priorityLimits: CloudFileConfig["defaults"]["priorityLimits"];
    publicationLimit: number;
  }): Promise<SiteManagementSnapshot>;
  renamePublication(tenant: TenantContext, publicationId: string, name: string): Promise<SiteManagementSnapshot>;
  reorderPublications(tenant: TenantContext, publicationIds: string[]): Promise<SiteManagementSnapshot>;
  setPublicationStatus(
    tenant: TenantContext,
    publicationId: string,
    status: "active" | "inactive",
  ): Promise<SiteManagementSnapshot>;
  updateHome(tenant: TenantContext, input: { name?: string; themeId?: string }): Promise<SiteManagementSnapshot>;
  setPublicationTheme(
    tenant: TenantContext,
    publicationId: string,
    theme: { mode: "inherit" } | { mode: "override"; themeId: string },
  ): Promise<SiteManagementSnapshot>;
  setTodoEnabled(tenant: TenantContext, enabled: boolean): Promise<SiteManagementSnapshot>;
}

function normalizeVisibleName(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") {
    throw new SiteManagementError("SITE_INPUT_INVALID", `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || [...normalized].length > maximum || CONTROL.test(normalized)) {
    throw new SiteManagementError("SITE_INPUT_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function requirePublicationId(value: unknown): string {
  if (typeof value !== "string" || !PUBLICATION_ID.test(value)) {
    throw new SiteManagementError("SITE_INPUT_INVALID", "publicationId is invalid");
  }
  return value;
}

function normalizeTheme(
  value: unknown,
): { mode: "inherit" } | { mode: "override"; themeId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SiteManagementError("SITE_INPUT_INVALID", "theme selection is invalid");
  }
  const selection = value as Record<string, unknown>;
  if (selection.mode === "inherit" && Object.keys(selection).length === 1) {
    return { mode: "inherit" };
  }
  if (
    selection.mode === "override"
    && Object.keys(selection).length === 2
    && typeof selection.themeId === "string"
    && PUBLICATION_ID.test(selection.themeId)
  ) {
    return { mode: "override", themeId: selection.themeId };
  }
  throw new SiteManagementError("SITE_INPUT_INVALID", "theme selection is invalid");
}

export class SiteManagementService {
  constructor(
    private readonly repository: SiteManagementRepository,
    private readonly defaults: Pick<CloudFileConfig["defaults"], "timeZone" | "priorityLimits">,
    private readonly publicationLimit: number,
  ) {
    if (!Number.isInteger(publicationLimit) || publicationLimit < 1) {
      throw new SiteManagementError("SITE_INPUT_INVALID", "publication limit is invalid");
    }
  }

  read(tenant: TenantContext): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    return this.repository.readSnapshot(tenant);
  }

  createPublication(tenant: TenantContext, input: {
    publicationId: unknown;
    name: unknown;
    theme: unknown;
  }): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    return this.repository.createPublication(tenant, {
      publicationId: requirePublicationId(input.publicationId),
      name: normalizeVisibleName(input.name, 40, "publication name"),
      theme: normalizeTheme(input.theme),
      timeZone: this.defaults.timeZone,
      priorityLimits: this.defaults.priorityLimits,
      publicationLimit: this.publicationLimit,
    });
  }

  renamePublication(
    tenant: TenantContext,
    publicationId: unknown,
    name: unknown,
  ): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    return this.repository.renamePublication(
      tenant,
      requirePublicationId(publicationId),
      normalizeVisibleName(name, 40, "publication name"),
    );
  }

  reorderPublications(tenant: TenantContext, publicationIds: unknown): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    if (
      !Array.isArray(publicationIds)
      || publicationIds.length === 0
      || publicationIds.some((value) => typeof value !== "string" || !PUBLICATION_ID.test(value))
      || new Set(publicationIds).size !== publicationIds.length
    ) {
      throw new SiteManagementError("SITE_INPUT_INVALID", "publication order is invalid");
    }
    return this.repository.reorderPublications(tenant, publicationIds);
  }

  setPublicationStatus(
    tenant: TenantContext,
    publicationId: unknown,
    status: unknown,
  ): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    if (status !== "active" && status !== "inactive") {
      throw new SiteManagementError("SITE_INPUT_INVALID", "publication status is invalid");
    }
    return this.repository.setPublicationStatus(tenant, requirePublicationId(publicationId), status);
  }

  updateHome(
    tenant: TenantContext,
    input: { name?: unknown; themeId?: unknown },
  ): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    if (input.name === undefined && input.themeId === undefined) {
      throw new SiteManagementError("SITE_INPUT_INVALID", "Home update is empty");
    }
    return this.repository.updateHome(tenant, {
      ...(input.name === undefined ? {} : { name: normalizeVisibleName(input.name, 40, "Home name") }),
      ...(input.themeId === undefined ? {} : { themeId: requirePublicationId(input.themeId) }),
    });
  }

  setPublicationTheme(
    tenant: TenantContext,
    publicationId: unknown,
    theme: unknown,
  ): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    return this.repository.setPublicationTheme(
      tenant,
      requirePublicationId(publicationId),
      normalizeTheme(theme),
    );
  }

  setTodoEnabled(tenant: TenantContext, enabled: unknown): Promise<SiteManagementSnapshot> {
    requireTenantContext(tenant);
    if (typeof enabled !== "boolean") {
      throw new SiteManagementError("SITE_INPUT_INVALID", "Todo enabled state is invalid");
    }
    return this.repository.setTodoEnabled(tenant, enabled);
  }
}
