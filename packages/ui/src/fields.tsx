import { useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

// Input states from frame NS2: Default, Focus (css), Passed check, Blocked, Error.
type Status = "passed" | "blocked";
type Common = { label: string; help?: string; note?: string; status?: Status; error?: string };

type Wired = { id: string; "aria-describedby"?: string; "aria-invalid"?: true; className: string };

/** Label, control, then help, note and error text, each linked to the control by aria-describedby. */
function Field({ id, label, help, note, status, error, render }: Common & { id?: string; render: (p: Wired) => ReactNode }) {
  const auto = useId();
  const fid = id ?? auto;
  const described = [help && `${fid}-help`, note && `${fid}-note`, error && `${fid}-error`].filter(Boolean).join(" ");
  const bad = !!error || status === "blocked";
  const border = bad ? "border-error" : status === "passed" ? "border-deep-green" : "border-line focus:border-ink";
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fid} className="font-semibold">
        {label}
      </label>
      {render({
        id: fid,
        "aria-describedby": described || undefined,
        ...(error ? { "aria-invalid": true as const } : {}),
        className: cx("w-full min-h-12 rounded-control border-[1.5px] bg-white px-4 py-2 text-ink placeholder:text-muted disabled:bg-disabled disabled:text-disabled-ink", border),
      })}
      {help && (
        <p id={`${fid}-help`} className="text-small text-muted">
          {help}
        </p>
      )}
      {note && (
        <p id={`${fid}-note`} className={cx("flex items-center gap-1.5 text-small font-semibold", status === "blocked" ? "text-error" : "text-deep-green")}>
          {status && <Icon name={status === "passed" ? "check" : "flag"} size={16} />}
          {note}
        </p>
      )}
      {error && (
        <p id={`${fid}-error`} role="alert" className="flex items-center gap-1.5 text-small font-semibold text-error">
          <Icon name="flag" size={16} />
          {error}
        </p>
      )}
    </div>
  );
}

type Rest<T extends "input" | "select" | "textarea"> = Omit<ComponentProps<T>, keyof Common | "children">;

export function Input({ label, help, note, status, error, ...rest }: Common & Rest<"input">) {
  return <Field id={rest.id} {...{ label, help, note, status, error }} render={(p) => <input {...rest} {...p} className={cx(p.className, rest.className)} />} />;
}

export function Textarea({ label, help, note, status, error, ...rest }: Common & Rest<"textarea">) {
  return <Field id={rest.id} {...{ label, help, note, status, error }} render={(p) => <textarea rows={4} {...rest} {...p} className={cx(p.className, rest.className)} />} />;
}

export function Select({ label, help, note, status, error, children, ...rest }: Common & Rest<"select"> & { children: ReactNode }) {
  return (
    <Field
      id={rest.id}
      {...{ label, help, note, status, error }}
      render={(p) => (
        <select {...rest} {...p} className={cx(p.className, rest.className)}>
          {children}
        </select>
      )}
    />
  );
}

type ChoiceProps = { label: string; help?: string; error?: string } & Omit<ComponentProps<"input">, "type" | "children" | "role">;

/** Checkbox, Radio and Toggle share one markup: the label wraps the control, so every control has a label. */
function Choice({ type, role, label, help, error, className, ...rest }: ChoiceProps & { type: "checkbox" | "radio"; role?: "switch" }) {
  const auto = useId();
  const id = rest.id ?? auto;
  const described = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ");
  const toggle = role === "switch";
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3">
        <input
          {...rest}
          id={id}
          type={type}
          role={role}
          aria-describedby={described || undefined}
          aria-invalid={error ? true : undefined}
          className={cx(toggle ? "h-6 w-11 appearance-none rounded-pill bg-line checked:bg-deep-green relative before:absolute before:left-0.5 before:top-0.5 before:size-5 before:rounded-pill before:bg-white before:transition-transform checked:before:translate-x-5" : "size-5 accent-deep-green", "disabled:opacity-60", className)}
        />
        <span>{label}</span>
      </label>
      {help && (
        <p id={`${id}-help`} className="ml-8 text-small text-muted">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="ml-8 text-small font-semibold text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export const Checkbox = (p: ChoiceProps) => <Choice type="checkbox" {...p} />;
export const Radio = (p: ChoiceProps) => <Choice type="radio" {...p} />;
export const Toggle = (p: ChoiceProps) => <Choice type="checkbox" role="switch" {...p} />;
