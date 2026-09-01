import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./tokens.css";
import "./styles.css";
import "./reading.css";

import { hydrateRoot } from "react-dom/client";
import { CopyInstructionIsland, CopySecretIsland, LoginIsland, LogoutIsland } from "./islands.js";
import { ImageFallbackIsland, SourceDialogIsland, TodoAnchorIsland, type ReadingSource } from "./reading-islands.js";

for (const root of document.querySelectorAll<HTMLElement>("[data-react-island]")) {
  const island = root.dataset.reactIsland;
  if (island === "login") {
    hydrateRoot(root, <LoginIsland basePath={root.dataset.basePath ?? ""} returnTo={root.dataset.returnTo || undefined} />);
  } else if (island === "copy-instruction") {
    hydrateRoot(root, <CopyInstructionIsland text={root.dataset.copyText ?? ""} />);
  } else if (island === "copy-secret") {
    hydrateRoot(root, <CopySecretIsland sourceId={root.dataset.sourceId ?? ""} returnPath={root.dataset.returnPath ?? "/settings/agent"} />);
  } else if (island === "sources") {
    let sources: ReadingSource[] = [];
    try { sources = JSON.parse(root.dataset.sources ?? "[]") as ReadingSource[]; } catch { sources = []; }
    hydrateRoot(root, <SourceDialogIsland title={root.dataset.sourceTitle ?? "全部来源"} sources={sources} archiveId={root.dataset.archiveId ?? ""} />);
  } else if (island === "image-fallback") {
    hydrateRoot(root, <ImageFallbackIsland imageId={root.dataset.imageId ?? ""} />);
  } else if (island === "todo-anchor") {
    hydrateRoot(root, <TodoAnchorIsland />);
  } else if (island === "logout") {
    hydrateRoot(root, <LogoutIsland basePath={root.dataset.basePath ?? ""} />);
  }
}
