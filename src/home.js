const selector = document.querySelector("#publication-select");

selector?.addEventListener("change", () => {
  location.assign(selector.value);
});
