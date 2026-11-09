import { useEffect, useRef } from "react";
import { Button, Form } from "react-bootstrap";

type SelectionBarProps = {
  id: string;
  /** Plural noun for the summary, e.g. "users". */
  noun: string;
  /** Every item in the list, regardless of the search filter. */
  allNames: string[];
  /** Items that match the current search (equal to allNames when no search). */
  matchingNames: string[];
  filterActive: boolean;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
};

/**
 * Ping-selection controls for a searchable list. The checkbox covers everything that
 * matches the search (across all pages, not just the visible one). The summary always
 * counts the whole list, so selected items hidden by the search are still visible here.
 */
export function SelectionBar({
  id,
  noun,
  allNames,
  matchingNames,
  filterActive,
  selected,
  onChange,
}: SelectionBarProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);

  const selectedCount = allNames.filter((n) => selected.has(n)).length;
  const matchingSelected = matchingNames.filter((n) => selected.has(n)).length;
  const hiddenSelected = selectedCount - matchingSelected;
  const allMatchingSelected =
    matchingNames.length > 0 && matchingSelected === matchingNames.length;
  const someMatchingSelected = matchingSelected > 0;
  const selectionIsExactlyMatching =
    allMatchingSelected && hiddenSelected === 0;

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate =
        someMatchingSelected && !allMatchingSelected;
    }
  }, [someMatchingSelected, allMatchingSelected]);

  function toggleMatching() {
    const next = new Set(selected);
    if (allMatchingSelected) matchingNames.forEach((n) => next.delete(n));
    else matchingNames.forEach((n) => next.add(n));
    onChange(next);
  }

  return (
    <div className="d-flex flex-wrap align-items-center column-gap-3 row-gap-1 small mb-3">
      <Form.Check
        ref={checkboxRef}
        type="checkbox"
        id={id}
        label={
          filterActive
            ? `All matching (${matchingNames.length})`
            : `All (${allNames.length})`
        }
        checked={allMatchingSelected}
        onChange={toggleMatching}
        disabled={matchingNames.length === 0}
        title={
          filterActive
            ? `Select / deselect all ${noun} matching the search (on every page)`
            : `Select / deselect all ${noun}`
        }
        className="mb-0 text-nowrap"
      />
      <span className="text-body-secondary">
        <strong className="text-body">{selectedCount}</strong> of {allNames.length}{" "}
        {noun} selected
        {hiddenSelected > 0 && (
          <span className="text-warning-emphasis">
            {" "}
            · {hiddenSelected} hidden by search
          </span>
        )}
      </span>
      <span className="d-flex gap-2 ms-auto">
        {filterActive && matchingNames.length > 0 && !selectionIsExactlyMatching && (
          <Button
            variant="link"
            size="sm"
            className="p-0 text-decoration-none"
            onClick={() => onChange(new Set(matchingNames))}
            title={`Select only the ${noun} matching the search and deselect the rest`}
          >
            Only matching
          </Button>
        )}
        {filterActive && selectedCount < allNames.length && (
          <Button
            variant="link"
            size="sm"
            className="p-0 text-decoration-none"
            onClick={() => onChange(new Set(allNames))}
          >
            Select all {allNames.length}
          </Button>
        )}
        {selectedCount > 0 && (
          <Button
            variant="link"
            size="sm"
            className="p-0 text-decoration-none"
            onClick={() => onChange(new Set())}
          >
            Clear
          </Button>
        )}
      </span>
    </div>
  );
}
