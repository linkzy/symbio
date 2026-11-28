import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SettingsGroup<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
}

/**
 * The groups of a settings page, as tabs across the top (scrolling sideways on a phone). Links when
 * `href` is given (Settings: the address keeps the group), buttons otherwise (a project's settings).
 */
export function SettingsTabs<T extends string>({
  groups,
  current,
  href,
  onPick,
}: {
  groups: SettingsGroup<T>[];
  current: T;
  href?: (id: T) => string;
  onPick?: (id: T) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  // On a phone the tabs scroll sideways: keep the open one in view.
  useEffect(() => {
    const on = nav.current?.querySelector<HTMLElement>(".settings-tab.on");
    if (on && nav.current) nav.current.scrollLeft = Math.max(0, on.offsetLeft - (nav.current.clientWidth - on.offsetWidth) / 2);
  }, [current]);
  return (
    <nav className="settings-tabs" role="tablist" ref={nav}>
      {groups.map((g) =>
        href ? (
          <a key={g.id} role="tab" aria-selected={g.id === current} className={`settings-tab ${g.id === current ? "on" : ""}`} href={href(g.id)} data-group={g.id}>
            {g.icon}
            {g.label}
          </a>
        ) : (
          <button key={g.id} role="tab" aria-selected={g.id === current} className={`settings-tab ${g.id === current ? "on" : ""}`} onClick={() => onPick?.(g.id)} data-group={g.id}>
            {g.icon}
            {g.label}
          </button>
        ),
      )}
    </nav>
  );
}

// ---- Settings (the whole app): the group is in the address, "#/settings/<group>".

export const SETTINGS_GROUPS = ["agents", "notifications", "connections", "usage", "computer", "about"] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number];

/** Where a link to one part of Settings goes. */
export const settingsHref = (group: SettingsGroupId) => `#/settings/${group}`;

function groupFromHash(): SettingsGroupId {
  let id = location.hash.match(/^#\/settings\/([\w-]+)/)?.[1];
  // Help became part of About (older links still land there).
  if (id === "help") id = "about";
  return (SETTINGS_GROUPS as readonly string[]).includes(id ?? "") ? (id as SettingsGroupId) : "agents";
}

export function useSettingsGroup(): SettingsGroupId {
  const [group, setGroup] = useState(groupFromHash);
  useEffect(() => {
    const onChange = () => setGroup(groupFromHash());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return group;
}

// ---- A project's settings: the group is remembered per project for the session.

export const PROJECT_SETTINGS_GROUPS = ["general", "team", "quality", "connections", "usage", "maintenance"] as const;
export type ProjectSettingsGroupId = (typeof PROJECT_SETTINGS_GROUPS)[number];

const key = (projectId: string) => `symbio:project-settings:${projectId}`;
const EVENT = "symbio:project-settings-group";

/** Opens a group of a project's settings (before showing its Settings tab, e.g. "Add a model" → team). */
export function showProjectSettings(projectId: string, group: ProjectSettingsGroupId) {
  sessionStorage.setItem(key(projectId), group);
  dispatchEvent(new Event(EVENT));
}

export function useProjectSettingsGroup(projectId: string): [ProjectSettingsGroupId, (g: ProjectSettingsGroupId) => void] {
  const read = (): ProjectSettingsGroupId => {
    const saved = sessionStorage.getItem(key(projectId));
    return (PROJECT_SETTINGS_GROUPS as readonly string[]).includes(saved ?? "") ? (saved as ProjectSettingsGroupId) : "general";
  };
  const [group, setGroup] = useState(read);
  useEffect(() => {
    setGroup(read());
    const onChange = () => setGroup(read());
    addEventListener(EVENT, onChange);
    return () => removeEventListener(EVENT, onChange);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  return [group, (g) => showProjectSettings(projectId, g)];
}
