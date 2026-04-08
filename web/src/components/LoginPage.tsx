import { FormEvent } from "react";
import { Alert, Button, Card, Col, Container, Form, Row, Spinner } from "react-bootstrap";

type LoginFormState = {
  username: string;
  password: string;
};

type LoginPageProps = {
  authError: string | null;
  loginForm: LoginFormState;
  loginPending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChange: (nextValue: LoginFormState) => void;
};

export function LoginPage({
  authError,
  loginForm,
  loginPending,
  onSubmit,
  onChange,
}: LoginPageProps) {
  return (
    <Container className="py-5 min-vh-100 d-flex align-items-center">
      <Row className="justify-content-center w-100">
        <Col xs={12} md={8} lg={5}>
          <Card className="shadow-sm">
            <Card.Body className="p-4 p-lg-5">
              <div className="mb-4">
                <div className="text-uppercase text-muted small fw-semibold mb-2">
                  LSM Admin
                </div>
                <h1 className="h3 mb-2">Sign in</h1>
                <p className="text-body-secondary mb-0">
                  Use the admin credentials configured in <code>.env</code>.
                </p>
              </div>

              {authError ? <Alert variant="danger">{authError}</Alert> : null}

              <Form onSubmit={onSubmit}>
                <Form.Group className="mb-3" controlId="login-username">
                  <Form.Label>Username</Form.Label>
                  <Form.Control
                    autoComplete="username"
                    value={loginForm.username}
                    onChange={(event) =>
                      onChange({
                        ...loginForm,
                        username: event.target.value,
                      })
                    }
                  />
                </Form.Group>

                <Form.Group className="mb-4" controlId="login-password">
                  <Form.Label>Password</Form.Label>
                  <Form.Control
                    type="password"
                    autoComplete="current-password"
                    value={loginForm.password}
                    onChange={(event) =>
                      onChange({
                        ...loginForm,
                        password: event.target.value,
                      })
                    }
                  />
                </Form.Group>

                <Button className="w-100" type="submit" disabled={loginPending}>
                  {loginPending ? (
                    <>
                      <Spinner size="sm" className="me-2" />
                      Checking credentials...
                    </>
                  ) : (
                    "Enter panel"
                  )}
                </Button>
              </Form>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
}
