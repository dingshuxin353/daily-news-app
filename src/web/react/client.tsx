import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./tokens.css";
import "./styles.css";

import { hydrateRoot } from "react-dom/client";
import { CopyInstructionIsland, CopySecretIsland, LoginIsland } from "./islands.js";

for (const root of document.querySelectorAll<HTMLElement>("[data-react-island]")) {
  const island = root.dataset.reactIsland;
  if (island === "login") {
    hydrateRoot(root, <LoginIsland basePath={root.dataset.basePath ?? ""} returnTo={root.dataset.returnTo || undefined} />);
  } else if (island === "copy-instruction") {
    hydrateRoot(root, <CopyInstructionIsland text={root.dataset.copyText ?? ""} />);
  } else if (island === "copy-secret") {
    hydrateRoot(root, <CopySecretIsland sourceId={root.dataset.sourceId ?? ""} returnPath={root.dataset.returnPath ?? "/settings/agent"} />);
  }
}
