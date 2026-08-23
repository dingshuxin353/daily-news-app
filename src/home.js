const selector = document.querySelector("#publication-select");

selector?.addEventListener("change", () => {
  location.assign(selector.value);
});

for (const image of document.querySelectorAll(".story__media img")) {
  image.addEventListener("error", () => {
    const media = image.closest(".story__media");
    const highlight = image.closest(".home-highlight");
    media?.remove();
    highlight?.classList.remove("home-highlight--media");
  }, { once: true });
}
