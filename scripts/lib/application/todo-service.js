import { planTodoCandidate } from "../domain/todo.js";
import { requireTodoStorage, requireTodoWriteTransaction } from "../storage/ports.js";

function rejectedStatus(input, state, error) {
  return {
    schemaVersion: 1,
    candidateId: input.candidateId,
    result: "rejected",
    revision: state.revision,
    operationCount: Array.isArray(input.candidate?.operations) ? input.candidate.operations.length : 0,
    field: error.field ?? null,
    reason: String(error.message ?? "Todo Candidate 处理失败"),
    processedAt: input.processedAt,
  };
}

export function createTodoApplicationService(storage, dependencies) {
  requireTodoStorage(storage);
  const { validateCandidate, validateState, generateId, normalizeNow } = dependencies;
  if (typeof validateCandidate !== "function" || typeof validateState !== "function") {
    throw new TypeError("Todo Application Service 必须提供 Candidate 与 State Validator");
  }
  if (typeof generateId !== "function") {
    throw new TypeError("Todo Application Service 必须提供正式 ID 生成器");
  }
  if (typeof normalizeNow !== "function") {
    throw new TypeError("Todo Application Service 必须提供时间规范化函数");
  }

  return Object.freeze({
    submit(input) {
      return storage.withWriteTransaction(input.candidateId, async (transaction) => {
        requireTodoWriteTransaction(transaction);
        const existingSubmission = await transaction.readSubmission();
        if (existingSubmission) return existingSubmission;

        const state = await transaction.readState();
        const processedInput = { ...input, processedAt: normalizeNow(input.now) };
        let plan;
        try {
          if (processedInput.candidateError) throw processedInput.candidateError;
          validateCandidate(processedInput.candidate, "candidate");
          if (processedInput.candidate.candidateId !== processedInput.candidateId) {
            const error = new Error("candidateId 必须与文件名一致");
            error.field = "candidateId";
            throw error;
          }
          plan = planTodoCandidate(state, processedInput.candidate, {
            now: processedInput.processedAt,
            generateId,
            validateState,
          });
        } catch (error) {
          const status = rejectedStatus(processedInput, state, error);
          await transaction.commit({ submission: status });
          return status;
        }

        const status = {
          schemaVersion: 1,
          candidateId: processedInput.candidate.candidateId,
          result: plan.result,
          baseRevision: processedInput.candidate.baseRevision,
          revision: plan.state.revision,
          operationCount: processedInput.candidate.operations.length,
          operations: plan.operationResults,
          warnings: [],
          pageUrl: "/todo/",
          processedAt: processedInput.processedAt,
        };
        await transaction.commit({
          ...(plan.result === "published" ? { state: plan.state } : {}),
          submission: status,
        });
        return status;
      });
    },
  });
}
