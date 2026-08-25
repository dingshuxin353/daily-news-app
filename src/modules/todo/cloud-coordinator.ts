import type { PostgresTodoStorage, TodoApplicationStorage } from "../../adapters/postgres/todo.js";
import { jsonSha256 } from "../shared/canonical-json.js";

interface TodoApplicationService {
  submit(input: {
    candidateId: string;
    candidate: unknown;
    now?: string | Date;
  }): Promise<Record<string, unknown>>;
}

export interface CloudTodoCoordinatorOptions {
  storage: PostgresTodoStorage;
  createApplicationService(storage: TodoApplicationStorage): TodoApplicationService;
}

export function createCloudTodoCoordinator(options: CloudTodoCoordinatorOptions) {
  return Object.freeze({
    async submit(input: {
      candidate: unknown;
      now?: string | Date;
    }): Promise<Record<string, unknown>> {
      if (!input.candidate || typeof input.candidate !== "object" || Array.isArray(input.candidate)) {
        throw new TypeError("Todo Candidate must be an object");
      }
      const candidateId = (input.candidate as Record<string, unknown>).candidateId;
      if (typeof candidateId !== "string") throw new TypeError("Todo Candidate must contain candidateId");
      return options.storage.runSubmission(
        {
          candidateId,
          payloadHash: jsonSha256(input.candidate),
          candidate: input.candidate,
        },
        async (storage) => options.createApplicationService(storage).submit({
          candidateId,
          candidate: input.candidate,
          now: input.now,
        }),
      );
    },
  });
}
