import { useEffect, useMemo, useReducer, useRef } from "react";
import { filterSections, flatten, pickerInit, pickerKey, pickerReducer, type SectionView } from "./logic";
import { Badges } from "./parts";

export function ModelPicker({
  id,
  label,
  sections,
  value,
  onChange,
  placeholder = "Search models",
}: {
  id: string;
  label: string;
  sections: SectionView[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [state, dispatch] = useReducer(pickerReducer, value, pickerInit);
  const listRef = useRef<HTMLDivElement>(null);
  const visibleSections = useMemo(() => filterSections(sections, state.query).filter((s) => s.models.length), [sections, state.query]);
  const visible = useMemo(() => flatten(visibleSections), [visibleSections]);
  const activeId = state.open && visible[state.active] ? `${id}-opt-${state.active}` : undefined;
  const selected = useMemo(() => flatten(sections).find((m) => m.id === value), [sections, value]);

  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const el = listRef.current.querySelector(`#${CSS.escape(activeId)}`);
    if (el && "scrollIntoView" in el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const choose = (modelId: string) => {
    dispatch({ type: "choose", id: modelId });
    onChange(modelId);
  };

  let index = -1;
  return (
    <div className="rt-picker" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && dispatch({ type: "close" })}>
      <label className="rt-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="rt-input rt-picker-input"
        role="combobox"
        aria-expanded={state.open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        placeholder={selected ? `${selected.displayName}  (${selected.id})` : value || placeholder}
        value={state.query}
        onFocus={() => dispatch({ type: "open" })}
        onChange={(e) => dispatch({ type: "query", query: e.target.value })}
        onKeyDown={(e) => {
          const action = pickerKey(e.key, state, visible);
          if (!action) return;
          e.preventDefault();
          if (action.type === "choose") choose(action.id);
          else dispatch(action);
        }}
      />
      {state.open && (
        <div className="rt-picker-pop" id={`${id}-list`} role="listbox" aria-label={label} ref={listRef}>
          {visible.length === 0 && <div className="rt-empty-inline">No model matches “{state.query}”.</div>}
          {visibleSections.map((s) => (
            <div key={s.providerId} role="group" aria-labelledby={`${id}-grp-${s.providerId}`}>
              <div className="rt-picker-group" id={`${id}-grp-${s.providerId}`}>
                {s.providerName}
              </div>
              {s.models.map((m) => {
                index += 1;
                const i = index;
                return (
                  <div
                    key={m.id}
                    id={`${id}-opt-${i}`}
                    role="option"
                    aria-selected={m.id === value}
                    data-active={i === state.active || undefined}
                    className="rt-option"
                    onMouseEnter={() => dispatch({ type: "hover", index: i })}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(m.id);
                    }}
                  >
                    <span className="rt-option-name">{m.displayName}</span>
                    <span className="rt-option-id">{m.id}</span>
                    <Badges badges={m.badges} loaded={m.loaded} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
