import { Alert, Button, Modal } from "react-bootstrap";
import { isDisabled, summarize, type InventoryApi, type SyncStep } from "../inventory";

type Section = { title: string; hint?: string; steps: SyncStep[]; show: (s: SyncStep) => string };

function sections(steps: SyncStep[], dry: boolean): Section[] {
  const of = (...kinds: SyncStep["kind"][]) => steps.filter((s) => s.ok && kinds.includes(s.kind));
  const will = (done: string, planned: string) => (dry ? planned : done);
  const all: Section[] = [
    { title: "Failed", steps: steps.filter((s) => !s.ok), show: (s) => `${s.email}: ${s.error}` },
    {
      title: "Conflicts",
      hint: "On the panel under this name with a different UUID, so these users' links won't connect. Overwrite makes the panel use LSM's UUID.",
      steps: of("conflict"),
      show: (s) => `${s.email}${s.detail ? ` (${s.detail})` : ""}`,
    },
    {
      title: "Disabled on the panel",
      hint: "LSM's UUID, but switched off, so these users can't connect. LSM never switches clients off; a panel traffic/expiry limit or a manual switch-off can, and so did renames by lsmnode 2.0–2.1 (they also dropped the flow). Re-enable turns them back on with the flow restored.",
      steps: steps.filter(isDisabled),
      show: (s) => (s.kind === "rename" ? `${s.email} (renamed from ${s.from})` : s.email),
    },
    {
      title: will("Re-enabled", "Will re-enable"),
      steps: steps.filter((s) => s.ok && (s.kind === "repair" || (s.kind === "rename" && s.reenable))),
      show: (s) => s.email,
    },
    {
      title: will("Renamed", "Will rename"),
      hint: "Same client (matched by UUID) under its old name; traffic stats and limits stay.",
      steps: of("rename"),
      show: (s) => `${s.from} → ${s.email}`,
    },
    { title: will("Added", "Will add"), steps: of("add"), show: (s) => s.email },
    { title: will("Attached to this inbound", "Will attach to this inbound"), steps: of("attach"), show: (s) => s.email },
    { title: will("UUID overwritten", "Will overwrite UUID"), steps: of("overwrite"), show: (s) => s.email },
    { title: will("Added alongside", "Will add alongside"), steps: of("keep-both"), show: (s) => `${s.email} as ${s.as}` },
    {
      title: will("Revoked", "Will revoke"),
      steps: steps.filter((s) => s.ok && (s.kind === "detach" || (s.kind === "delete" && s.reason === "revoked"))),
      show: (s) => (s.kind === "detach" ? `${s.email} (detached; stays on its other inbounds)` : s.email),
    },
    {
      title: will("Removed leftover copies", "Will remove leftover copies"),
      hint: "An old-name copy of a client that is already on the panel under its new name.",
      steps: steps.filter((s) => s.ok && s.kind === "delete" && s.reason === "duplicate"),
      show: (s) => s.email,
    },
  ];
  return all.filter((x) => x.steps.length);
}

/** Per-client outcome of a 3x-ui push or check, with follow-up actions. */
export function SyncReportModal({ inv }: { inv: InventoryApi }) {
  const report = inv.syncReport;
  const dry = !!report?.options.dryRun;
  const withConflicts = report?.results.filter((r) => r.steps?.some((s) => s.kind === "conflict")).map((r) => r.nodeId) ?? [];
  const withDisabled = report?.results.filter((r) => r.steps?.some(isDisabled)).map((r) => r.nodeId) ?? [];
  const again = (ids: number[], options = report?.options ?? {}) => {
    inv.closeSyncReport();
    void inv.push(ids, undefined, { onConflict: options.onConflict, repair: options.repair });
  };
  return (
    <Modal show={report !== null} onHide={inv.closeSyncReport} size="lg" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{dry ? "Check: nothing was changed" : "Push details"}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {report?.results.map((r) => {
          const list = r.steps ? sections(r.steps, dry) : [];
          const unchanged = r.steps?.filter((s) => s.kind === "unchanged" || s.kind === "not-found").length ?? 0;
          return (
            <div key={r.nodeId} className="mb-4">
              <div className="d-flex justify-content-between align-items-baseline gap-2">
                <h3 className="h6 mb-1">{r.name}</h3>
                <small className="text-body-secondary">{summarize(r)}</small>
              </div>
              {r.error && !r.steps && <Alert variant="danger" className="py-2 small">{r.error}</Alert>}
              {!r.steps && !r.error && (
                <p className="small text-body-secondary mb-0">
                  Replaces the whole user list on the agent ({r.synced} users); there is nothing to preview per user.
                </p>
              )}
              {list.map((sec) => (
                <details key={sec.title} className="small mb-1" open={sec.title === "Failed" || sec.title === "Conflicts"}>
                  <summary>
                    {sec.title} ({sec.steps.length})
                  </summary>
                  {sec.hint && <div className="text-body-secondary my-1">{sec.hint}</div>}
                  <ul className="mb-1 font-monospace" style={{ maxHeight: "12rem", overflow: "auto" }}>
                    {sec.steps.map((s, i) => (
                      <li key={i}>{sec.show(s)}</li>
                    ))}
                  </ul>
                </details>
              ))}
              {r.steps && unchanged > 0 && (
                <div className="small text-body-secondary">{unchanged} already in place</div>
              )}
            </div>
          );
        })}
      </Modal.Body>
      <Modal.Footer>
        {withConflicts.length > 0 && (
          <>
            <Button variant="outline-secondary" onClick={() => again(withConflicts, { ...report?.options, onConflict: "keep-both" })}>
              Push, keep both
            </Button>
            <Button variant="outline-danger" onClick={() => again(withConflicts, { ...report?.options, onConflict: "overwrite" })}>
              Push, overwrite conflicts
            </Button>
          </>
        )}
        {withDisabled.length > 0 && (
          <Button variant="outline-primary" onClick={() => again(withDisabled, { ...report?.options, repair: true })}>
            Push, re-enable disabled
          </Button>
        )}
        {dry && report && (
          <Button onClick={() => again(report.results.map((r) => r.nodeId))}>
            Push now
            {[
              report.options.onConflict && report.options.onConflict !== "skip" ? report.options.onConflict : null,
              report.options.repair ? "re-enable" : null,
            ]
              .filter(Boolean)
              .map((x) => ` (${x})`)
              .join("")}
          </Button>
        )}
        <Button variant="outline-secondary" onClick={inv.closeSyncReport}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
