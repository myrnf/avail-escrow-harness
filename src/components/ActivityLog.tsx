import { Panel, PanelStatus } from "./primitives/Panel";
import { useActivityLog, logTime } from "../store/activityLog";

export function ActivityLog() {
  const entries = useActivityLog((s) => s.entries);

  return (
    <Panel
      title="Activity log"
      status={<PanelStatus state="ok">Healthy</PanelStatus>}
    >
      {entries.length === 0 ? (
        <div className="log__empty">— no activity yet —</div>
      ) : (
        <div className="log">
          {entries.map((e) => (
            <div key={e.id} className="log__row">
              <span className="ts">{logTime(e.ts)}</span>
              <span className={`lvl ${e.level}`}>{e.channel}</span>
              <span className="msg">
                {e.message}
                {e.details ? <span className="extra">· {e.details}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
