import type { HTMLAttributes } from "react";

type Variant = "default" | "success" | "warn" | "fail" | "accent";

type Props = HTMLAttributes<HTMLSpanElement> & {
  variant?: Variant;
  dot?: boolean;
};

const variantClass: Record<Variant, string> = {
  default: "chip",
  success: "chip chip-success",
  warn: "chip chip-warn",
  fail: "chip chip-fail",
  accent: "chip chip-accent",
};

export function Chip({ variant = "default", dot, className = "", children, ...rest }: Props) {
  return (
    <span className={`${variantClass[variant]} ${className}`.trim()} {...rest}>
      {dot && <span className="status-dot" />}
      {children}
    </span>
  );
}
