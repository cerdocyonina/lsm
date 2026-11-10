import { Spinner } from "react-bootstrap";
import { TbCheck } from "react-icons/tb";

/** One toggle pill per profile: filled = this server is in that profile's subscription. */
export function ProfileChips({
  profiles,
  isOn,
  onToggle,
  isBusy = () => false,
  disabled = false,
  label,
}: {
  profiles: string[];
  isOn: (profile: string) => boolean;
  onToggle: (profile: string, next: boolean) => void;
  isBusy?: (profile: string) => boolean;
  disabled?: boolean;
  /** Accessible name prefix, e.g. the server name. */
  label: string;
}) {
  if (!profiles.length) return <span className="text-body-tertiary small">No profiles</span>;
  return (
    <div className="d-flex gap-1 flex-wrap" role="group" aria-label={`Profiles using ${label}`}>
      {profiles.map((p) => {
        const on = isOn(p);
        const busy = isBusy(p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            aria-label={`${on ? "Remove" : "Add"} ${label} ${on ? "from" : "to"} ${p}`}
            title={on ? `In ${p}. Click to remove.` : `Not in ${p}. Click to add.`}
            disabled={disabled || busy}
            className={`btn btn-sm rounded-pill py-0 px-2 d-inline-flex align-items-center gap-1 ${
              on ? "btn-primary" : "btn-outline-secondary"
            }`}
            onClick={() => onToggle(p, !on)}
          >
            {busy ? <Spinner size="sm" style={{ width: 10, height: 10 }} /> : on ? <TbCheck size={12} /> : null}
            {p}
          </button>
        );
      })}
    </div>
  );
}
