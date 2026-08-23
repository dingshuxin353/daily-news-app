import { shanghaiDate } from "./home.js";
import { validateTodoState } from "./todo-validation.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function compareText(left, right) {
  return left.localeCompare(right, "zh-CN");
}

function compareDue(left, right) {
  return compareText(left.dueDate, right.dueDate)
    || compareText(left.dueTime ?? "99:99", right.dueTime ?? "99:99")
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.id, right.id);
}

function compareCreated(left, right) {
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

function shanghaiDateForTimestamp(timestamp) {
  return shanghaiDate(new Date(timestamp));
}

export function buildTodoProjection(state, options = {}) {
  validateTodoState(state);
  const asOfDate = options.asOfDate ?? shanghaiDate();
  if (!DATE_PATTERN.test(asOfDate)) throw new Error("Todo asOfDate 必须是 YYYY-MM-DD");

  const open = state.items.filter(({ status }) => status === "open");
  const overdue = open.filter(({ dueDate }) => dueDate && dueDate < asOfDate).sort(compareDue);
  const today = open.filter(({ dueDate }) => dueDate === asOfDate).sort(compareDue);
  const upcoming = open.filter(({ dueDate }) => dueDate && dueDate > asOfDate).sort(compareDue);
  const undated = open.filter(({ dueDate }) => !dueDate).sort(compareCreated);
  const completedToday = state.items
    .filter(({ status, completedAt }) => (
      status === "completed"
      && completedAt
      && shanghaiDateForTimestamp(completedAt) === asOfDate
    ))
    .sort((left, right) => compareText(right.completedAt, left.completedAt) || compareText(left.id, right.id));

  return {
    schemaVersion: 1,
    sourceRevision: state.revision,
    asOfDate,
    groups: {
      overdue: structuredClone(overdue),
      today: structuredClone(today),
      upcoming: structuredClone(upcoming),
      undated: structuredClone(undated),
      completedToday: structuredClone(completedToday),
    },
    homeItems: structuredClone([...overdue, ...today, ...upcoming, ...undated].slice(0, 5)),
  };
}
