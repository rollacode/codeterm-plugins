import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { api } from "./api";
import type { Overview, SectionView } from "./logic";
import { ModelsPanel } from "./Models";
import { Segmented } from "./parts";
import { PresetsPanel } from "./Presets";
import { ProvidersPanel } from "./Providers";

type Tab = "providers" | "models" | "presets";

export function App() {
  const [tab, setTab] = useState<Tab>("providers");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sections, setSections] = useState<SectionView[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await api.overview());
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  const loadModels = useCallback(async (force: boolean) => {
    setLoadingModels(true);
    try {
      setSections((await api.models({ refresh: force })).sections);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab !== "providers" && sections === null && !loadingModels) void loadModels(false);
  }, [tab, sections, loadingModels, loadModels]);

  const changed = useCallback(() => {
    void refresh();
    setSections(null);
  }, [refresh]);

  const modelCount = sections ? sections.reduce((n, s) => n + s.total, 0) : undefined;
  return (
    <main className="rt-app">
      <header className="rt-top">
        <div className="rt-brand">
          <h1>Router</h1>
          <p className="rt-dim">One chat backend, many model providers.</p>
        </div>
        <Segmented<Tab>
          idPrefix="rt"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "providers", label: "Providers", count: overview?.providers.length },
            { id: "models", label: "Models", count: modelCount },
            { id: "presets", label: "Presets", count: overview?.presets.length },
          ]}
        />
      </header>
      {error && (
        <div className="rt-note rt-note-err" role="alert">
          {error}
        </div>
      )}
      <section id={`rt-panel-${tab}`} role="tabpanel" aria-labelledby={`rt-tab-${tab}`} className="rt-body" tabIndex={-1}>
        {!overview ? (
          <p className="rt-dim">Loading…</p>
        ) : tab === "providers" ? (
          <ProvidersPanel overview={overview} onChanged={changed} />
        ) : tab === "models" ? (
          <ModelsPanel sections={sections} loading={loadingModels} onRefresh={() => void loadModels(true)} />
        ) : (
          <PresetsPanel presets={overview.presets} sections={sections || []} onChanged={changed} />
        )}
      </section>
    </main>
  );
}

const root = document.getElementById("ct-root");
if (root) createRoot(root).render(<App />);
