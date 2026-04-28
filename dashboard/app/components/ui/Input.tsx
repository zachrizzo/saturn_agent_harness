import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = "", ...rest }, ref
) {
  return <input ref={ref} className={`input ${className}`.trim()} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = "", ...rest }, ref
) {
  return <textarea ref={ref} className={`input resize-y ${className}`.trim()} {...rest} />;
});
