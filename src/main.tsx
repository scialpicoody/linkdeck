import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root mount point");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
