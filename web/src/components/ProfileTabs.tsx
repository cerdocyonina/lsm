import { useRef, useState } from "react";
import { Button, Form, Modal, Nav } from "react-bootstrap";
import { TbPencil, TbPlus, TbTrash } from "react-icons/tb";
import type { ProfileRecord } from "../types";

type ProfileTabsProps = {
  profiles: ProfileRecord[];
  activeProfileName: string;
  onSelect: (name: string) => void;
  onCreateProfile: (name: string) => void;
  onRenameProfile: (name: string, newName: string) => void;
  onDeleteProfile: (name: string) => void;
};

export function ProfileTabs({
  profiles,
  activeProfileName,
  onSelect,
  onCreateProfile,
  onRenameProfile,
  onDeleteProfile,
}: ProfileTabsProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");

  const [renameTarget, setRenameTarget] = useState<ProfileRecord | null>(null);
  const [renameName, setRenameName] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<ProfileRecord | null>(null);

  const createNameRef = useRef<HTMLInputElement>(null);

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim()) return;
    onCreateProfile(createName.trim());
    setCreateName("");
    setShowCreate(false);
  }

  function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget || !renameName.trim()) return;
    onRenameProfile(renameTarget.name, renameName.trim());
    setRenameTarget(null);
    setRenameName("");
  }

  function openRename(profile: ProfileRecord, e: React.MouseEvent) {
    e.stopPropagation();
    setRenameTarget(profile);
    setRenameName(profile.name);
  }

  function openDelete(profile: ProfileRecord, e: React.MouseEvent) {
    e.stopPropagation();
    setDeleteTarget(profile);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    onDeleteProfile(deleteTarget.name);
    setDeleteTarget(null);
  }

  return (
    <>
      <div className="border-bottom bg-white">
        <div className="container-fluid px-3" style={{ maxWidth: "1320px", margin: "0 auto" }}>
          <Nav variant="tabs" className="border-bottom-0 flex-nowrap overflow-auto" style={{ gap: 2 }}>
            {profiles.map((profile) => (
              <Nav.Item key={profile.id} className="d-flex align-items-center">
                <Nav.Link
                  active={profile.name === activeProfileName}
                  onClick={() => onSelect(profile.name)}
                  className="d-flex align-items-center gap-1 pe-2 user-select-none"
                  style={{ cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  {profile.name}
                  <button
                    type="button"
                    className="btn btn-link p-0 ms-1 text-body-secondary"
                    style={{ fontSize: 12, lineHeight: 1, opacity: 0.6 }}
                    title={`Rename "${profile.name}"`}
                    onClick={(e) => openRename(profile, e)}
                    tabIndex={-1}
                  >
                    <TbPencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-link p-0 text-danger"
                    style={{ fontSize: 12, lineHeight: 1, opacity: 0.6 }}
                    title={`Delete "${profile.name}"`}
                    onClick={(e) => openDelete(profile, e)}
                    tabIndex={-1}
                  >
                    <TbTrash size={13} />
                  </button>
                </Nav.Link>
              </Nav.Item>
            ))}

            <Nav.Item>
              <Nav.Link
                onClick={() => {
                  setShowCreate(true);
                  setTimeout(() => createNameRef.current?.focus(), 50);
                }}
                className="text-body-secondary d-flex align-items-center gap-1"
                style={{ cursor: "pointer" }}
                title="Create new profile"
              >
                <TbPlus size={16} />
              </Nav.Link>
            </Nav.Item>
          </Nav>
        </div>
      </div>

      {/* Create profile modal */}
      <Modal show={showCreate} onHide={() => setShowCreate(false)} centered size="sm">
        <Form onSubmit={handleCreateSubmit}>
          <Modal.Header closeButton>
            <Modal.Title className="h6">New profile</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group>
              <Form.Label className="small fw-semibold">Name</Form.Label>
              <Form.Control
                ref={createNameRef}
                size="sm"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. work"
                pattern="^[a-z0-9_-]+$"
                title="Lowercase letters, digits, hyphens, underscores"
                required
              />
              <Form.Text className="text-body-secondary">Lowercase alphanumeric, hyphens, underscores.</Form.Text>
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button variant="primary" size="sm" type="submit">Create</Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Rename profile modal */}
      <Modal show={renameTarget !== null} onHide={() => setRenameTarget(null)} centered size="sm">
        <Form onSubmit={handleRenameSubmit}>
          <Modal.Header closeButton>
            <Modal.Title className="h6">Rename profile</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group>
              <Form.Label className="small fw-semibold">New name</Form.Label>
              <Form.Control
                size="sm"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                pattern="^[a-z0-9_-]+$"
                title="Lowercase letters, digits, hyphens, underscores"
                autoFocus
                required
              />
              <Form.Text className="text-body-secondary">Lowercase alphanumeric, hyphens, underscores.</Form.Text>
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" size="sm" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button variant="primary" size="sm" type="submit">Save</Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal show={deleteTarget !== null} onHide={() => setDeleteTarget(null)} centered size="sm">
        <Modal.Header closeButton>
          <Modal.Title className="h6">Delete profile</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="mb-0">
            Delete <strong>{deleteTarget?.name}</strong>? All users and servers in this profile will be permanently removed.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={confirmDelete}>Delete</Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
