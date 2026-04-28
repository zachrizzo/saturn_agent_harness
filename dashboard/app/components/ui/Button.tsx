import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "default" | "primary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const variantClass: Record<Variant, string> = {
  default: "btn",
  primary: "btn btn-primary",
  ghost: "btn btn-ghost",
  danger: "btn",
};

const sizeClass: Record<Size, string> = {
  sm: "text-[12px] py-1 px-2.5",
  md: "",
  icon: "btn-icon",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "default", size = "md", className = "", children, ...rest },
  ref
) {
  const danger = variant === "danger" ? "text-[var(--fail)] border-[color-mix(in_srgb,var(--fail)_30%,var(--border))]" : "";
  return (
    <button
      ref={ref}
      className={`${variantClass[variant]} ${sizeClass[size]} ${danger} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
});
