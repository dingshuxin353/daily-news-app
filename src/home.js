const selector = document.querySelector("#publication-select");

selector?.addEventListener("change", () => {
  location.assign(selector.value);
});

function removeFailedImage(image) {
  const media = image.closest(".story__media");
  const highlight = image.closest(".home-highlight");
  media?.remove();
  highlight?.classList.remove("home-highlight--media");
}

for (const image of document.querySelectorAll(".story__media img")) {
  image.addEventListener("error", () => removeFailedImage(image), { once: true });
  if (image.complete && image.naturalWidth === 0) removeFailedImage(image);
}
