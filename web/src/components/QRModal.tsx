import { QRCodeSVG } from "qrcode.react";
import React from "react";
import { Alert, Modal, Stack } from "react-bootstrap";
import { UserRecord } from "../types";

interface QRModalProps {
  show: boolean;
  setShow: (value: boolean) => void;
  user?: UserRecord | null;
}

const QRModal: React.FC<QRModalProps> = ({ show, setShow, user }) => {
  return (
    <Modal show={show} onHide={() => setShow(false)}>
      <Modal.Header closeButton>
        <Modal.Title>QR Code</Modal.Title>
      </Modal.Header>
      <Modal.Body className="d-flex justify-content-center">
        {user ? (
          <Stack gap={3} className="align-items-center">
            <QRCodeSVG
              value={user.subscriptionUrl}
              size={256}
              bgColor={"#ffffff"}
              fgColor={"#000000"}
              level={"L"}
            />
            <div className="text-muted">
              {user.clientName} (UUID: {user.userUuid})
            </div>
          </Stack>
        ) : (
          <Alert variant="danger">err - no user selected</Alert>
        )}
      </Modal.Body>
    </Modal>
  );
};

export default QRModal;
