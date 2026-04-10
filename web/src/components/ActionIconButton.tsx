import type { ReactNode } from "react";
import { Button, ButtonProps } from "react-bootstrap";

type ActionIconButtonProps = ButtonProps & {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  variant: "outline-secondary" | "outline-primary" | "outline-danger";
};

export function ActionIconButton({
  icon,
  label,
  onClick,
  variant,
  ...props
}: ActionIconButtonProps) {
  return (
    <Button
      aria-label={label}
      className="admin-icon-button d-flex align-items-center justify-content-center p-1"
      onClick={onClick}
      title={label}
      type="button"
      variant={variant}
      style={{ width: "32px", height: "32px", lineHeight: 0 }}
      {...props}
    >
      {icon}
    </Button>
  );
}
