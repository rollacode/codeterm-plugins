import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { RepoEntry, WorktreeEntry } from "./gitApi";

interface RepoSwitcherProps {
  repos: RepoEntry[];
  worktrees: WorktreeEntry[];
  activePath: string;
  onSelect: (path: string) => void;
}

interface MenuPos {
  top: number;
  left: number;
  minWidth: number;
  maxWidth: number;
}

// Compact repo dropdown (name + dimmed branch) shown when cwd holds >1 repo.
// Menu renders through a portal so the toolbar's overflow-x:auto can't clip it.
export function RepoSwitcher({ repos, worktrees, activePath, onSelect }: RepoSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRepo = repos.find((repo) => repo.path === activePath);
  const activeWorktree = worktrees.find((worktree) => worktree.path === activePath);
  const active = activeRepo ?? activeWorktree ?? repos[0] ?? worktrees[0];

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxWidth = Math.max(180, window.innerWidth - margin * 2);
    const width = Math.min(Math.max(rect.width, 240), maxWidth);
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    setPos({ top: rect.bottom + 4, left, minWidth: Math.min(rect.width, width), maxWidth: width });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!active) return null;

  return (
    <div className="ct-git-repos shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className="ct-git-repos-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Switch repository"
      >
        <span className="name">{"name" in active ? active.name : baseName(active.path)}</span>
        {active.branch && <span className="branch">{active.branch}</span>}
        {worktrees.length > 1 && <span className="count">{worktrees.length} worktrees</span>}
        <ChevronDown size={12} className="opacity-60" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="ct-git-repos-menu"
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, maxWidth: pos.maxWidth }}
          >
            {repos.length > 1 && <div className="ct-git-repos-section">Repositories</div>}
            {repos.length > 1 && repos.map((r) => (
              <button
                key={r.path}
                type="button"
                className={`ct-git-repos-item${r.path === activePath ? " is-active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (r.path !== activePath) onSelect(r.path);
                }}
              >
                <span className="name">{r.name}</span>
                {r.branch && <span className="branch">{r.branch}</span>}
              </button>
            ))}
            {worktrees.length > 0 && <div className="ct-git-repos-section">Worktrees</div>}
            {worktrees.map((worktree) => (
              <button
                key={worktree.path}
                type="button"
                className={`ct-git-repos-item ct-git-worktree-item${worktree.path === activePath ? " is-active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (worktree.path !== activePath) onSelect(worktree.path);
                }}
              >
                <span className="ct-git-worktree-main">
                  <span className="name">{baseName(worktree.path)}</span>
                  <span className="branch">{worktree.branch ?? (worktree.detached ? "detached" : "bare")}</span>
                  {worktree.locked && <span className="state">locked</span>}
                  {worktree.prunable && <span className="state warn">prunable</span>}
                </span>
                <span className="path">{worktree.path}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function baseName(path: string): string {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}
