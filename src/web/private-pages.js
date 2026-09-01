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
    }
  });
}
