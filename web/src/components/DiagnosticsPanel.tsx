import { Button, Card, Form, Table } from "react-bootstrap";
import type {
  ClientHttpPingResult,
  ServerIcmpResult,
  ServerRecord,
} from "../types";
export function DiagnosticsPanel({
  servers,
  icmp,
  http,
  pinging,
  selectionMode,
  selected,
  onToggleSelection,
  onToggleServer,
  onPing,
}: {
  servers: ServerRecord[];
  icmp: ServerIcmpResult[];
  http: ClientHttpPingResult[];
  pinging: boolean;
  selectionMode: boolean;
  selected: Set<string>;
  onToggleSelection: () => void;
  onToggleServer: (name: string) => void;
  onPing: () => void;
}) {
  return (
    <Card className="mt-3">
      <Card.Body>
        <div className="d-flex gap-3 justify-content-between align-items-center">
          <h2 className="h6 mb-0">Connection diagnostics</h2>
          <Button
            size="sm"
            onClick={onPing}
            disabled={pinging || !servers.length}
          >
            {pinging
              ? "Pinging…"
              : selectionMode
                ? "Ping selected"
                : "Ping all"}
          </Button>
        </div>
        <Form.Check
          className="mt-2"
          label="Select connections and users to ping"
          checked={selectionMode}
          onChange={onToggleSelection}
        />
        <Table size="sm" responsive className="mt-2">
          <tbody>
            {servers.map((s) => {
              const r = icmp.find((r) => r.serverName === s.name)?.icmp;
              return (
                <tr key={s.name}>
                  <td>
                    {selectionMode ? (
                      <Form.Check
                        label={s.name}
                        checked={selected.has(s.name)}
                        onChange={() => onToggleServer(s.name)}
                      />
                    ) : (
                      s.name
                    )}
                  </td>
                  <td>{r ? (r.ok ? `${r.latencyMs} ms` : r.error) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {http.length > 0 && (
          <Table size="sm" responsive>
            <thead>
              <tr>
                <th>User</th>
                {http[0].servers.map((s) => (
                  <th key={s.serverName}>{s.serverName}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {http.map((u) => (
                <tr key={u.clientName}>
                  <td>{u.clientName}</td>
                  {u.servers.map((s) => (
                    <td key={s.serverName}>
                      {s.result.ok
                        ? `${s.result.latencyMs} ms`
                        : s.result.error}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  );
}
