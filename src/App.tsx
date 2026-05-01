import { useState } from "react";
import { Header } from "./components/Header";
import { SwapForm } from "./components/SwapForm";
import { IntentPanel } from "./components/IntentPanel";
import { ActivityLog } from "./components/ActivityLog";
import { StatusStrip } from "./components/StatusStrip";
import { TransactionsPanel } from "./components/TransactionsPanel";
import { useIntentTiming, isInFlight as computeInFlight } from "./store/intentTiming";

export default function App() {
  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);
  const steps = useIntentTiming((s) => s.steps);
  const endedAt = useIntentTiming((s) => s.endedAt);
  const inFlight = computeInFlight(steps, endedAt);

  return (
    <div className="app">
      <Header />
      <main className="main">
        <section className="workspace">
          <div>
            <SwapForm
              isInFlight={inFlight}
              onIntentCreated={setActiveIntentId}
            />
          </div>
          <div className="workspace-col">
            <div className="workspace-row">
              <IntentPanel intentId={activeIntentId} />
              <TransactionsPanel intentId={activeIntentId} />
            </div>
            <ActivityLog />
          </div>
        </section>
      </main>
      <StatusStrip intentId={activeIntentId} />
    </div>
  );
}
