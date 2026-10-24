import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface FieldOption {
  value: string;
  label: string;
}

interface FieldSelectProps {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly FieldOption[];
  placeholder?: string;
}

/**
 * Accessible select (keyboard navigation, typeahead, Escape) styled to the
 * workbench tokens. Replaces native `<select>` in the channel config form.
 */
export function FieldSelect({
  id,
  label,
  value,
  onValueChange,
  options,
  placeholder,
}: FieldSelectProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select.Root value={value} onValueChange={onValueChange}>
        <Select.Trigger
          id={id}
          className={cn(
            "flex min-h-9 w-full items-center justify-between gap-2 rounded-[var(--radius)]",
            "border border-input bg-card px-2.5 text-sm text-foreground",
            "focus:outline-2 focus:outline-ring",
          )}
        >
          <Select.Value placeholder={placeholder ?? label} />
          <Select.Icon asChild>
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-50 max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-auto rounded-[var(--radius)] border border-border bg-card p-1 text-card-foreground shadow-md"
          >
            <Select.Viewport>
              {options.map((o) => (
                <Select.Item
                  key={o.value}
                  value={o.value}
                  className="flex cursor-default items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted"
                >
                  <Select.ItemText>{o.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
