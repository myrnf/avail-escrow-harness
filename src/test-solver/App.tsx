import { Header } from "./Header";
import { SwapForm } from "./SwapForm";
import { SwapPanel } from "./SwapPanel";
import { useSessionStore } from "./store/session";

export default function TestSolverApp() {
  const swap = useSessionStore((s) => s.swap);

  return (
    <div className="app">
      <Header />
      <main className="main">
        <div className="test-solver__banner">
          TEST-SOLVER · real money · base mainnet · algo comparison harness
        </div>
        <section className="workspace">
          <div>
            <SwapForm />
          </div>
          <div>
            <SwapPanel swap={swap} />
          </div>
        </section>
      </main>
    </div>
  );
}
