import { useRef, useState } from "react";
import { Button, Form, Modal, Nav } from "react-bootstrap";
import { TbPlus } from "react-icons/tb";
import type { ProfileRecord } from "../types";

type ProfileTabsProps = {
  profiles: ProfileRecord[];
  activeProfileName: string;
  onSelect: (name: string) => void;
  onCreateProfile: (name: string) => void;
};

export function ProfileTabs({
  profiles,
  activeProfileName,
  onSelect,
  onCreateProfile,
}: ProfileTabsProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const createNameRef = useRef<HTMLInputElement>(null);

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim()) return;
    onCreateProfile(createName.trim());
    setCreateName("");
    setShowCreate(false);
  }

  return (
    <>
      <div className="border-bottom bg-white">
        <div className="container-fluid px-3" style={{ maxWidth: "1320px", margin: "0 auto" }}>
          <Nav variant="tabs" className="border-bottom-0 flex-nowrap overflow-auto" style={{ gap: 2 }}>
            {profiles.map((profile) => (
              <Nav.Item key={profile.id}>
                <Nav.Link
                  active={profile.name === activeProfileName}
                  onClick={() => onSelect(profile.name)}
                  className="user-select-none"
                  style={{ cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  {profile.name}
                </Nav.Link>
              </Nav.Item>
            ))}

            <Nav.Item>
              <Nav.Link
                onClick={() => {
                  setShowCreate(true);
                  setTimeout(() => createNameRef.current?.focus(), 50);
                }}
                className="text-body-secondary"
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
    </>
  );
}
