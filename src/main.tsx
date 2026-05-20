import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import App from "./App";
import TestSolverApp from "./test-solver/App";
import { Web3Provider } from "./providers/Web3Provider";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing");

// Minimal path-based routing without adding a router dep. Two pages live in
// the same SPA: the Avail Escrow harness at `/`, and the test-solver harness
// at `/test-solver`. Vercel rewrites (vercel.json) serve `index.html` for
// either path; this dispatch picks the right root.
const isTestSolver = window.location.pathname.startsWith("/test-solver");
const RootApp = isTestSolver ? TestSolverApp : App;

createRoot(rootEl).render(
  <StrictMode>
    <Web3Provider>
      <RootApp />
    </Web3Provider>
  </StrictMode>
);
