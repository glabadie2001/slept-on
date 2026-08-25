import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installGlobalErrorCapture, log } from "./lib/log";
import "./styles.css";

installGlobalErrorCapture();
log.info("app", "Session started");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
