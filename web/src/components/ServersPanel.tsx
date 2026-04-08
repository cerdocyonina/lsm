import { FormEvent } from "react";
import { Button, Card, Form, ListGroup, Stack } from "react-bootstrap";
import {
  ActionIconButton,
  DeleteIcon,
  EditIcon,
} from "./ActionIconButton";
import type { ServerFormState, ServerRecord } from "../types";

type ServersPanelProps = {
  editingServer: ServerRecord | null;
  onCancelEdit: () => void;
  onDeleteServer: (name: string) => void;
  onEditServer: (server: ServerRecord) => void;
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
  onSubmit,
  savingServer,
  serverForm,
  servers,
  setServerForm,
}: ServersPanelProps) {
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
            <Button variant="outline-secondary" type="button" onClick={onCancelEdit}>
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

        <ListGroup variant="flush">
          {servers.map((server) => (
            <ListGroup.Item className="px-0 py-3" key={server.name}>
              <div className="admin-list-item">
                <div className="admin-list-copy">
                  <div className="fw-semibold">{server.name}</div>
                  <div className="text-body-secondary">Order: {server.sortOrder}</div>
                  <div className="admin-code-wrap">
                    <code>{server.template}</code>
                  </div>
                </div>
                <Stack className="admin-actions-column" gap={2}>
                  <ActionIconButton
                    icon={<EditIcon />}
                    label="Edit server"
                    onClick={() => onEditServer(server)}
                    variant="outline-primary"
                  />
                  <ActionIconButton
                    icon={<DeleteIcon />}
                    label="Delete server"
                    onClick={() => onDeleteServer(server.name)}
                    variant="outline-danger"
                  />
                </Stack>
              </div>
            </ListGroup.Item>
          ))}
        </ListGroup>
      </Card.Body>
    </Card>
  );
}
