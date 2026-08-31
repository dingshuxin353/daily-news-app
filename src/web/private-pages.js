const body = document.body;
const basePath = body.dataset.basePath || "";

const pageSelect = document.querySelector("[data-page-select]");
if (pageSelect instanceof HTMLSelectElement) {
  pageSelect.addEventListener("change", () => window.location.assign(pageSelect.value));
}

for (const image of document.querySelectorAll("[data-reading-image]")) {
  if (!(image instanceof HTMLImageElement)) continue;
  const showImageFallback = () => {
    image.hidden = true;
    const fallback = image.parentElement?.querySelector("[data-image-fallback]");
    if (fallback instanceof HTMLElement) fallback.hidden = false;
  };
  image.addEventListener("error", showImageFallback, { once: true });
  if (image.complete && image.naturalWidth === 0) showImageFallback();
}

const sourceDialog = document.querySelector("[data-source-dialog]");
if (sourceDialog instanceof HTMLDialogElement && typeof sourceDialog.showModal === "function") {
  const sourceArchive = document.querySelector(".source-archive");
  const sourceDialogTitle = sourceDialog.querySelector("[data-source-dialog-title]");
  const sourceDialogContent = sourceDialog.querySelector("[data-source-dialog-content]");
  const sourceDialogClose = sourceDialog.querySelector("[data-source-close]");
  let sourceTrigger = null;
  if (sourceArchive instanceof HTMLElement) sourceArchive.hidden = true;
  for (const trigger of document.querySelectorAll("[data-source-open]")) {
    if (!(trigger instanceof HTMLButtonElement)) continue;
    trigger.hidden = false;
    trigger.addEventListener("click", () => {
      const sourceSet = document.getElementById(trigger.dataset.sourceOpen || "");
      const list = sourceSet?.querySelector("ol");
      if (!sourceSet || !list || !sourceDialogContent || !sourceDialogTitle) return;
      sourceTrigger = trigger;
      sourceDialogTitle.textContent = sourceSet.dataset.sourceTitle || "全部来源";
      sourceDialogContent.replaceChildren(list.cloneNode(true));
      sourceDialog.showModal();
      if (sourceDialogClose instanceof HTMLButtonElement) sourceDialogClose.focus();
    });
  }
  sourceDialogClose?.addEventListener("click", () => sourceDialog.close());
  sourceDialog.addEventListener("close", () => {
    if (sourceTrigger instanceof HTMLElement) sourceTrigger.focus();
    sourceTrigger = null;
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const key = button.dataset.copy;
    const source = document.querySelector(`[data-copy-source="${CSS.escape(key)}"]`);
    const status = document.querySelector(`[data-copy-status="${CSS.escape(key)}"]`);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent || "");
      if (status) status.textContent = key === "secret" ? "Token 已复制。" : "设置话术已复制。";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (status) status.textContent = "浏览器未允许自动复制，内容已选中，请手工复制。";
    }
  });
}

for (const form of document.querySelectorAll("[data-settings-form]")) {
  if (!(form instanceof HTMLFormElement)) continue;
  const status = form.querySelector("[data-form-status]");
  const visibleText = (value) => {
    const normalized = value.trim();
    return normalized.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(normalized);
  };
  const validate = (input) => {
    if (!(input instanceof HTMLInputElement) || input.readOnly || input.type === "hidden" || input.type === "radio") return true;
    const maximum = input.maxLength > 0 ? input.maxLength : undefined;
    const value = input.value.trim();
    const valid = visibleText(value)
      && (maximum === undefined || [...value].length <= maximum)
      && (input.name !== "publicationId" || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value));
    input.setCustomValidity(valid ? "" : input.name === "publicationId" ? "请使用小写字母、数字和单个连字符。" : `请输入不超过 ${maximum} 个可见字符。`);
    input.toggleAttribute("aria-invalid", !valid);
    return valid;
  };
  for (const input of form.querySelectorAll("input")) {
    input.addEventListener("blur", () => {
      if (!validate(input)) input.reportValidity();
    });
    input.addEventListener("input", () => validate(input));
  }
  form.addEventListener("submit", (event) => {
    const valid = [...form.querySelectorAll("input")].every(validate) && form.checkValidity();
    if (!valid) {
      event.preventDefault();
      form.reportValidity();
      if (status) status.textContent = "请先修正标出的内容。";
      return;
    }
  });
}

const oneTimeSecret = document.querySelector('[data-copy-source="secret"]');
if (oneTimeSecret instanceof HTMLElement) {
  const returnPath = oneTimeSecret.closest("[data-secret-return]")?.dataset.secretReturn || `${basePath}/settings/agent`;
  window.history.replaceState(null, "", returnPath);
  window.addEventListener("pagehide", () => {
    oneTimeSecret.textContent = "";
  }, { once: true });
}

if (window.location.hash) {
  const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
  const status = document.querySelector("[data-anchor-status]");
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
  } else if (body.dataset.page === "todo" && status instanceof HTMLElement) {
    status.hidden = false;
    status.focus();
  }
}
