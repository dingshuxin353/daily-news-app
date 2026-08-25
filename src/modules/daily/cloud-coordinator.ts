import type {
  DailyApplicationStorage,
  PostgresDailyStorage,
  PriorityLimits,
} from "../../adapters/postgres/daily.js";
import { jsonSha256 } from "../shared/canonical-json.js";

interface DailyApplicationService {
  submit(input: {
    candidate: unknown;
    publicationId: string;
    priorityLimits: PriorityLimits;
    mode: "update" | "replace";
  }): Promise<Record<string, unknown>>;
}

export interface CloudDailyCoordinatorOptions {
  storage: PostgresDailyStorage;
  publicationId: string;
  validateCandidate(candidate: unknown): unknown | Promise<unknown>;
  createApplicationService(storage: DailyApplicationStorage): DailyApplicationService;
}

export function createCloudDailyCoordinator(options: CloudDailyCoordinatorOptions) {
  return Object.freeze({
    async submit(input: {
      clientRunId: string;
      candidate: unknown;
      mode?: "update" | "replace";
    }): Promise<Record<string, unknown>> {
      const candidate = await options.validateCandidate(input.candidate);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("validated Daily Candidate must be an object");
      }
      const date = (candidate as Record<string, unknown>).date;
      if (typeof date !== "string") throw new TypeError("validated Daily Candidate must contain a date");
      const mode = input.mode ?? "update";
      const payloadHash = jsonSha256({ candidate, mode });
      return options.storage.runSubmission(
        {
          clientRunId: input.clientRunId,
          date,
          mode,
          payloadHash,
          candidate,
        },
        async (storage, priorityLimits) => options.createApplicationService(storage).submit({
          candidate,
          publicationId: options.publicationId,
          priorityLimits,
          mode,
        }),
      );
    },
  });
}
