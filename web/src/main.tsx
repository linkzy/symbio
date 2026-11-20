import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter";
import "./styles.css";
import "./themes.css";
import { applyTheme } from "./theme";
import { applyLocale } from "./i18n";

// Before the first render, so the page never flashes the default look.
applyTheme();
applyLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
