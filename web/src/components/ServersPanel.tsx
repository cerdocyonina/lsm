import { FormEvent, useRef, useState } from "react";
import { Button, Card, Form, ListGroup } from "react-bootstrap";
import { TbGripVertical, TbTrash as DeleteIcon, TbEdit as EditIcon } from "react-icons/tb";
import type { ServerFormState, ServerRecord } from "../types";
import { ActionIconButton } from "./ActionIconButton";

type ServersPanelProps = {
  editingServer: ServerRecord | null;
  onCancelEdit: () => void;
  onDeleteServer: (name: string) => void;
  onEditServer: (server: ServerRecord) => void;
  onReorder: (names: string[]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  savingServer: boolean;
  serverForm: ServerFormState;
  servers: ServerRecord[];
  setServerForm: (next: ServerFormState) => void;
};

export function ServersPanel({
  editingServer,
  onCancelEdit,
  onDeleteServer,
  onEditServer,
  onReorder,
  onSubmit,
  savingServer,
  serverForm,
  servers,
  setServerForm,
}: ServersPanelProps) {
  const [search, setSearch] = useState("");
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragSrcIdx = useRef<number | null>(null);

  const filteredServers = search.trim()
    ? servers.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.template.toLowerCase().includes(search.toLowerCase()),
      )
    : servers;

  const isDraggable = !search.trim();

  function handleDragStart(index: number) {
    dragSrcIdx.current = index;
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    setDragOverIdx(index);
  }

  function handleDrop(e: React.DragEvent, dstIdx: number) {
    e.preventDefault();
    setDragOverIdx(null);
    const srcIdx = dragSrcIdx.current;
    dragSrcIdx.current = null;
    if (srcIdx === null || srcIdx === dstIdx) return;
    const reordered = [...servers];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(dstIdx, 0, moved);
    onReorder(reordered.map((s) => s.name));
  }

  function handleDragEnd() {
    dragSrcIdx.current = null;
    setDragOverIdx(null);
  }

  return (
    <Card className="shadow-sm h-100">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-4">
          <div>
            <div className="text-uppercase text-muted small fw-semibold mb-1">
              Servers
            </div>
            <h2 className="h5 mb-0">
              {editingServer ? "Edit server" : "Create server"}
            </h2>
          </div>
          {editingServer ? (
            <Button
              variant="outline-secondary"
              type="button"
              onClick={onCancelEdit}
            >
              Cancel edit
            </Button>
          ) : null}
        </div>

        <Form onSubmit={onSubmit}>
          <Form.Group className="mb-3" controlId="server-name">
            <Form.Label>Name</Form.Label>
            <Form.Control
              required
              value={serverForm.name}
              onChange={(event) =>
                setServerForm({
                  ...serverForm,
                  name: event.target.value,
                })
              }
            />
          </Form.Group>

          <Form.Group className="mb-3" controlId="server-template">
            <Form.Label>Template</Form.Label>
            <Form.Control
              as="textarea"
              rows={4}
              required
              value={serverForm.template}
              onChange={(event) =>
                setServerForm({
                  ...serverForm,
                  template: event.target.value,
                })
              }
            />
          </Form.Group>

          <Button type="submit" disabled={savingServer}>
            {savingServer
              ? "Saving..."
              : editingServer
                ? "Update server"
                : "Add server"}
          </Button>
        </Form>

        <hr className="my-4" />

        <Form.Group className="mb-3" controlId="server-search">
          <Form.Control
            type="search"
            placeholder="Search by name or template…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Form.Group>

        <ListGroup variant="flush">
          {filteredServers.map((server, index) => (
            <ListGroup.Item
              className={`px-0 py-3${dragOverIdx === index ? " bg-body-secondary" : ""}`}
              key={server.name}
              draggable={isDraggable}
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
            >
              <div
                className="admin-list-item"
                style={isDraggable ? { gridTemplateColumns: "auto minmax(0,1fr) auto" } : undefined}
              >
                {isDraggable && (
                  <div
                    className="text-body-tertiary d-flex align-items-center"
                    style={{ cursor: "grab", touchAction: "none" }}
                  >
                    <TbGripVertical size={18} />
                  </div>
                )}
                <div className="admin-list-copy">
                  <div className="fw-semibold">{server.name}</div>
                  <div className="admin-code-wrap">
                    <code>{server.template}</code>
                  </div>
                  <div className="admin-meta">
                    <small className="text-muted">
                      {new Date(server.createdAt).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                      })}
                    </small>
                  </div>
                </div>
                <div className="admin-actions-grid">
                  <ActionIconButton
                    size="sm"
                    icon={<EditIcon />}
                    label="Edit server"
                    onClick={() => onEditServer(server)}
                    variant="outline-primary"
                  />
                  <ActionIconButton
                    size="sm"
                    icon={<DeleteIcon />}
                    label="Delete server"
                    onClick={() => onDeleteServer(server.name)}
                    variant="outline-danger"
                  />
                </div>
              </div>
            </ListGroup.Item>
          ))}
        </ListGroup>
      </Card.Body>
    </Card>
  );
}
