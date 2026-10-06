import { useMemo, useState } from "react";
import { filterSections, type SectionView } from "./logic";
import { Badges, Spinner, StatusPill } from "./parts";

export function ModelsPanel({ sections, loading, onRefresh }: { sections: SectionView[] | null; loading: boolean; onRefresh: () => void }) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const filtered = useMemo(() => (sections ? filterSections(sections, query) : []), [sections, query]);
  const shown = filtered.reduce((n, s) => n + s.models.length, 0);
  const total = (sections || []).reduce((n, s) => n + s.total, 0);

  return (
    <div className="rt-stack">
      <div className="rt-toolbar">
        <label className="rt-sr" htmlFor="model-search">
          Search models
        </label>
        <input
          id="model-search"
          type="search"
          className="rt-input rt-search"
          placeholder="Search by name, id, provider, or capability (vision, tools, 128k)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          aria-describedby="model-count"
        />
        <button type="button" className="rt-btn" onClick={onRefresh} disabled={loading}>
          {loading ? <Spinner /> : null}Refresh models
        </button>
      </div>
      <p className="rt-dim" id="model-count" aria-live="polite">
        {sections ? (query ? `${shown} of ${total} models match` : `${total} models from ${sections.length} providers`) : "Loading models…"}
      </p>
      {sections && sections.length === 0 && <div className="rt-empty">No provider is enabled. Add or enable one under Providers.</div>}
      {filtered.map((s) => {
        const open = !collapsed[s.providerId];
        const regionId = `models-${s.providerId}`;
        return (
          <section key={s.providerId} className="rt-section" aria-labelledby={`${regionId}-h`}>
            <h3 className="rt-section-head" id={`${regionId}-h`}>
              <button
                type="button"
                className="rt-section-toggle"
                aria-expanded={open}
                aria-controls={regionId}
                onClick={() => setCollapsed((c) => ({ ...c, [s.providerId]: open }))}
              >
                <span className="rt-caret" aria-hidden="true" data-open={open || undefined} />
                {s.providerName}
                <span className="rt-dim">{query ? `${s.models.length}/${s.total}` : s.total}</span>
              </button>
              {s.status.state !== "connected" && <StatusPill state={s.status.state} />}
            </h3>
            {open && (
              <div id={regionId}>
                {s.status.state !== "connected" && s.models.length === 0 ? (
                  <p className="rt-hint">{s.status.message}</p>
                ) : s.models.length === 0 ? (
                  <p className="rt-hint">No match in {s.providerName}.</p>
                ) : (
                  <ul className="rt-models">
                    {s.models.map((m) => (
                      <li key={m.id} className="rt-model">
                        <span className="rt-model-name">{m.displayName}</span>
                        <code className="rt-model-id">{m.id}</code>
                        <Badges badges={m.badges} loaded={m.loaded} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
