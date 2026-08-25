import { shanghaiDate } from "./home.js";
import { buildTodoProjection as buildDomainTodoProjection } from "./domain/todo-projection.js";

export { buildDomainTodoProjection };

export function buildTodoProjection(state, options = {}) {
  return buildDomainTodoProjection(state, {
    ...options,
    asOfDate: options.asOfDate ?? shanghaiDate(),
  });
}
