import { useRef, useState } from "react";
import { Check, Upload, X } from "lucide-react";
import { addCustomTheme, allThemes, LAYOUTS, removeCustomTheme, useLayout, useTheme } from "./theme";
import { parseVsCodeTheme } from "./vscodeTheme";
import { LOCALES, useI18n } from "./i18n";

/** Settings → Appearance: the theme, kept in this browser. */
export function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const [layout, setLayout] = useLayout();
  const { locale, setLocale, t } = useI18n();
  const developer = theme === "dark-modern" && layout === "workbench";
  const [, refresh] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importTheme(file: File) {
    setImportError(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error(t("appearance.importTheme.tooLarge"));
      addCustomTheme(parseVsCodeTheme(await file.text(), file.name));
      refresh((n) => n + 1);
    } catch (e) {
      setImportError((e as Error).message);
    }
  }
  return (
    <section className="section" id="appearance">
      <div className="section-head">
        <div>
          <h2>{t("appearance.title")}</h2>
          <p>{t("appearance.desc")}</p>
        </div>
      </div>
      <div className="section-body">
        <div className="appearance-label">{t("appearance.language")}</div>
        <p className="small subtle" style={{ margin: "0 0 8px" }}>{t("appearance.language.desc")}</p>
        <div className="seg" role="radiogroup" aria-label={t("appearance.language")} style={{ marginBottom: 22 }}>
          {LOCALES.map((l) => (
            <button key={l.id} role="radio" aria-checked={locale === l.id} className={locale === l.id ? "on" : ""} onClick={() => setLocale(l.id)}>
              {l.native}
            </button>
          ))}
        </div>
        <div className="appearance-label">{t("appearance.colors")}</div>
        <div className="theme-cards" role="radiogroup" aria-label={t("appearance.colors")}>
          {allThemes().map((tTheme) => (
            <div key={tTheme.id} className="theme-card-wrap">
              <button
                className={`theme-card ${theme === tTheme.id ? "on" : ""}`}
                role="radio"
                aria-checked={theme === tTheme.id}
                data-theme-id={tTheme.id}
                onClick={() => setTheme(tTheme.id)}
              >
                <span className="theme-preview" style={{ background: tTheme.swatch[0] }} aria-hidden>
                  <span className="theme-preview-side" style={{ background: tTheme.swatch[1] }} />
                  <span className="theme-preview-lines">
                    <span style={{ background: tTheme.swatch[2] }} />
                    <span style={{ background: tTheme.swatch[2], width: "60%" }} />
                    <span style={{ background: tTheme.swatch[3], width: "35%" }} />
                  </span>
                </span>
                <span className="theme-card-text">
                  <span className="list-title">
                    {tTheme.label} {theme === tTheme.id && <Check size={13} />}
                  </span>
                  <span className="list-sub">{tTheme.description}</span>
                </span>
              </button>
              {tTheme.custom && (
                <button
                  className="theme-card-remove"
                  title={`Remove ${tTheme.label}`}
                  aria-label={`Remove ${tTheme.label}`}
                  onClick={() => {
                    removeCustomTheme(tTheme.id);
                    refresh((n) => n + 1);
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="appearance-preset">
          <button className="btn sm" onClick={() => fileInput.current?.click()}>
            <Upload size={13} />
            {t("appearance.importTheme")}
          </button>
          <span className="small subtle">{t("appearance.importTheme.hint")}</span>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.jsonc,application/json"
            hidden
            data-testid="theme-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importTheme(f);
            }}
          />
        </div>
        {importError && <div className="error" style={{ marginTop: 10 }}>{importError}</div>}
        <div className="appearance-label">{t("appearance.layout")}</div>
        <div className="theme-cards" role="radiogroup" aria-label={t("appearance.layout")}>
          {LAYOUTS.map((l) => (
            <button key={l.id} className={`theme-card ${layout === l.id ? "on" : ""}`} role="radio" aria-checked={layout === l.id} data-layout-id={l.id} onClick={() => setLayout(l.id)}>
              <span className={`layout-preview ${l.id}`} aria-hidden>
                {l.id === "classic" ? (
                  <>
                    <span />
                    <span className="accent" />
                  </>
                ) : (
                  <>
                    <span />
                    <span />
                    <span />
                    <span className="accent" />
                  </>
                )}
              </span>
              <span className="theme-card-text">
                <span className="list-title">
                  {t(`appearance.layout.${l.id}` as any)} {layout === l.id && <Check size={13} />}
                </span>
                <span className="list-sub">{t(`appearance.layout.${l.id}.desc` as any)}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="appearance-preset">
          <button
            className="btn sm"
            disabled={developer}
            onClick={() => {
              setTheme("dark-modern");
              setLayout("workbench");
            }}
          >
            {developer ? <Check size={13} /> : null}
            {t("appearance.developerLook")}
          </button>
          <span className="small subtle">{t("appearance.developerLook.desc")}</span>
        </div>
      </div>
    </section>
  );
}
