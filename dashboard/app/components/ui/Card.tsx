import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & { interactive?: boolean };

export function Card({ interactive, className = "", children, ...rest }: Props) {
  return (
    <div className={`card ${interactive ? "card-interactive" : ""} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-4 py-3 border-b border-[var(--border)] ${className}`.trim()} {...rest}>{children}</div>;
}

export function CardBody({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 ${className}`.trim()} {...rest}>{children}</div>;
}
