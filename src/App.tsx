import { Header } from "./components/Header";
import { SwapForm } from "./components/SwapForm";
import { IntentPanel } from "./components/IntentPanel";
import { ActivityLog } from "./components/ActivityLog";
import { TransactionsPanel } from "./components/TransactionsPanel";
import { ContractsPanel } from "./components/ContractsPanel";
import { useCurrentLifecycle } from "./hooks/useCurrentLifecycle";
import { isInFlight } from "./store/intentTiming";

export default function App() {
  const lifecycle = useCurrentLifecycle();
  const inFlight = isInFlight(lifecycle);

  return (
    <div className="app">
      <Header />
      <main className="main">
        <section className="workspace">
          <div>
            <SwapForm isInFlight={inFlight} />
          </div>
          <div className="workspace-col">
            <div className="workspace-row">
              <IntentPanel />
              <TransactionsPanel />
            </div>
            <div className="workspace-row">
              <ContractsPanel />
              <ActivityLog />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
