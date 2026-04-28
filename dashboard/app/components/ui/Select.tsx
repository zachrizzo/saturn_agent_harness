import { forwardRef, type SelectHTMLAttributes } from "react";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = "", children, ...rest }, ref
) {
  return (
    <select ref={ref} className={`input pr-8 appearance-none ${className}`.trim()} {...rest}>
      {children}
    </select>
  );
});
