import { useEffect, useRef, useState } from "react";
import { IconExternalLink, IconX } from "@tabler/icons-react";
import { parseTodoAnchorHash } from "./reading-interactions.js";

export interface ReadingSource {
  name: string;
  url: string;
  originalTitle?: string;
  publishedAt?: string;
  via?: { name: string; url: string };
}

function SourceList({ sources }: { sources: ReadingSource[] }) {
  return (
    <ol className="m51-source-list">
      {sources.map((source, index) => (
        <li key={`${source.url}-${index}`}>
          <p className="m51-source-role">
            {index === 0 ? "主要来源" : "补充来源"}
          </p>
          <h3>{source.name}</h3>
          {source.originalTitle ? <p>{source.originalTitle}</p> : null}
          {source.publishedAt
            ? <time dateTime={source.publishedAt}>{source.publishedAt}</time>
            : null}
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            <span>打开原文</span>
            <IconExternalLink size={15} stroke={1.8} aria-hidden="true" />
          </a>
          {source.via
            ? (
              <p className="m51-source-via">
                <span>经由</span>
                <a
                  href={source.via.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.via.name}
                </a>
              </p>
            )
            : null}
        </li>
      ))}
    </ol>
  );
}

export function SourceDialogIsland(
  input: { title: string; sources: ReadingSource[]; archiveId: string },
) {
  const [enhanced, setEnhanced] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const actionLabel = `查看全部 ${input.sources.length} 个来源`;

  useEffect(() => {
    const archive = document.getElementById(input.archiveId);
    if (archive) archive.hidden = true;
    setEnhanced(true);
    return () => {
      if (archive) archive.hidden = false;
    };
  }, [input.archiveId]);

  return (
    <>
      <button
        ref={triggerRef}
        className="m51-source-action"
        type="button"
        hidden={!enhanced}
        onClick={() => dialogRef.current?.showModal()}
      >
        {actionLabel}
      </button>
      <a
        className="m51-source-action"
        href={`#${input.archiveId}`}
        hidden={enhanced}
      >
        {actionLabel}
      </a>
      <dialog
        ref={dialogRef}
        className="m51-source-dialog"
        aria-labelledby={`${input.archiveId}-dialog-title`}
        onClose={() => triggerRef.current?.focus()}
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current.close();
        }}
      >
        <header>
          <div>
            <p className="m51-kicker">来源清单</p>
            <h2 id={`${input.archiveId}-dialog-title`}>{input.title}</h2>
          </div>
          <button
            type="button"
            aria-label="关闭来源清单"
            onClick={() => dialogRef.current?.close()}
          >
            <IconX size={20} aria-hidden="true" />
          </button>
        </header>
        <SourceList sources={input.sources} />
      </dialog>
    </>
  );
}

export function ImageFallbackIsland({ imageId }: { imageId: string }) {
  useEffect(() => {
    const image = document.getElementById(imageId);
    if (!(image instanceof HTMLImageElement)) return;
    const fallback = image.parentElement?.querySelector<HTMLElement>(
      "[data-image-fallback]",
    );
    const showFallback = () => {
      image.hidden = true;
      if (fallback) fallback.hidden = false;
    };
    image.addEventListener("error", showFallback, { once: true });
    if (image.complete && image.naturalWidth === 0) showFallback();
    return () => image.removeEventListener("error", showFallback);
  }, [imageId]);
  return null;
}

export function TodoAnchorIsland() {
  useEffect(() => {
    const resolveAnchor = () => {
      const status = document.querySelector<HTMLElement>(
        "[data-anchor-status]",
      );
      const anchor = parseTodoAnchorHash(window.location.hash);
      if (anchor.kind === "none") {
        if (status) status.hidden = true;
        return;
      }
      const target = anchor.kind === "valid"
        ? document.getElementById(anchor.id)
        : null;
      if (target instanceof HTMLElement) {
        if (status) status.hidden = true;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "center" });
      } else if (status) {
        status.hidden = false;
        status.focus();
      }
    };
    resolveAnchor();
    window.addEventListener("hashchange", resolveAnchor);
    return () => window.removeEventListener("hashchange", resolveAnchor);
  }, []);
  return null;
}

export { SourceList };
