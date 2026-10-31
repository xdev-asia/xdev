import { tokensCss } from "@xdev/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";

const style = document.createElement("style");
style.textContent = tokensCss();
document.head.prepend(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
