import { useEffect, useState } from "react";
import { Form, FormControl, Pagination } from "react-bootstrap";

interface PaginatorProps {
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  totalCount: number;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

export function Paginator({ page, setPage, pageSize, onPageSizeChange, totalCount }: PaginatorProps) {
  const totalPages = pageSize === 0 ? 1 : Math.ceil(totalCount / pageSize);

  const [showInputLeft, setShowInputLeft] = useState(false);
  const [showInputRight, setShowInputRight] = useState(false);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, setPage, totalPages]);

  const handlePageInput = () => {
    const parsed = parseInt(inputValue);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= totalPages) {
      setPage(parsed);
    }
    setShowInputLeft(false);
    setShowInputRight(false);
    setInputValue("");
  };

  const createItems = () => {
    const items: React.ReactNode[] = [];
    const delta = 2;
    const range: (number | "ellipsis-left" | "ellipsis-right")[] = [];

    const left = Math.max(2, page - delta);
    const right = Math.min(totalPages - 1, page + delta);

    range.push(1);
    if (left > 2) range.push("ellipsis-left");
    for (let i = left; i <= right; i++) range.push(i);
    if (right < totalPages - 1) range.push("ellipsis-right");
    if (totalPages > 1) range.push(totalPages);

    for (const item of range) {
      if (item === "ellipsis-left") {
        items.push(
          showInputLeft ? (
            <Pagination.Item key="input-left" active>
              <FormControl
                type="number"
                size="sm"
                style={{ width: 70 }}
                autoFocus
                min={1}
                max={totalPages}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onBlur={handlePageInput}
                onKeyDown={(e) => e.key === "Enter" && handlePageInput()}
              />
            </Pagination.Item>
          ) : (
            <Pagination.Item
              key="ellipsis-left"
              onClick={() => { setShowInputLeft(true); setShowInputRight(false); }}
            >
              …
            </Pagination.Item>
          ),
        );
      } else if (item === "ellipsis-right") {
        items.push(
          showInputRight ? (
            <Pagination.Item key="input-right" active>
              <FormControl
                type="number"
                size="sm"
                style={{ width: 70 }}
                autoFocus
                min={1}
                max={totalPages}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onBlur={handlePageInput}
                onKeyDown={(e) => e.key === "Enter" && handlePageInput()}
              />
            </Pagination.Item>
          ) : (
            <Pagination.Item
              key="ellipsis-right"
              onClick={() => { setShowInputRight(true); setShowInputLeft(false); }}
            >
              …
            </Pagination.Item>
          ),
        );
      } else {
        items.push(
          <Pagination.Item key={item} active={item === page} onClick={() => setPage(Number(item))}>
            {item}
          </Pagination.Item>,
        );
      }
    }
    return items;
  };

  const from = pageSize === 0 ? 1 : pageSize * (page - 1) + 1;
  const to = pageSize === 0 ? totalCount : Math.min(totalCount, pageSize * page);

  return (
    <div className="d-flex flex-wrap align-items-center gap-3 mt-3">
      {totalPages > 1 && (
        <Pagination className="mb-0 flex-wrap">
          <Pagination.Prev disabled={page === 1} onClick={() => setPage(page - 1)} />
          {createItems()}
          <Pagination.Next disabled={page === totalPages} onClick={() => setPage(page + 1)} />
        </Pagination>
      )}
      <Form.Select
        size="sm"
        style={{ width: "auto" }}
        value={pageSize}
        onChange={(e) => onPageSizeChange(parseInt(e.target.value, 10))}
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n} / page</option>
        ))}
        <option value={0}>All</option>
      </Form.Select>
      {totalCount > 0 && (
        <small className="text-muted">
          {pageSize === 0 ? `${totalCount} items` : `${from}–${to} of ${totalCount}`}
        </small>
      )}
    </div>
  );
}
