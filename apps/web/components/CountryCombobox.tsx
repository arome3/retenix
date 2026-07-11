"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { COUNTRIES } from "@retenix/shared";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/*
 * Searchable region picker over the full ISO 3166-1 list (doc 04: "full ISO
 * list, search"). Radix Select gives only first-letter typeahead, so this is the
 * WAI-ARIA combobox+listbox pattern: an input filters by name/code, arrow keys
 * move the active option, Enter/click selects. The whole option row is the tap
 * target (well over the 24px minimum, WCAG 2.5.8). "region" — never "location"
 * or a banned term.
 */
const LIST_ID = "country-listbox";
const optionId = (code: string) => `country-opt-${code}`;

export function CountryCombobox({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = useMemo(
    () => COUNTRIES.find((c) => c.code === value) ?? null,
    [value],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q,
    );
  }, [query]);

  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  // Keep the highlighted option visible while arrowing through ~250 rows.
  useEffect(() => {
    if (!open) return;
    const code = results[activeIndex]?.code;
    if (!code) return;
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(code))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, results]);

  function choose(code: string) {
    onChange(code);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(activeIndex + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const country = results[activeIndex];
      if (country) choose(country.code);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setActive(0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Region"
          className={cn(
            "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-body transition-micro disabled:cursor-not-allowed disabled:opacity-50",
            !selected && "text-muted-foreground",
          )}
        >
          <span className="line-clamp-1">
            {selected ? selected.name : "Select your region"}
          </span>
          <ChevronDownIcon
            className="size-4 shrink-0 opacity-50"
            strokeWidth={1.5}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <div className="p-2">
          <Input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              results[activeIndex] ? optionId(results[activeIndex].code) : undefined
            }
            placeholder="Search countries"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          aria-label="Countries"
          className="max-h-64 overflow-y-auto p-1"
        >
          {results.length === 0 ? (
            <li className="px-2 py-3 text-center text-small text-muted-foreground">
              No match
            </li>
          ) : (
            results.map((country, index) => {
              const isActive = index === activeIndex;
              const isSelected = country.code === value;
              // The option element itself is the control (WAI-ARIA listbox
              // pattern); the input owns keyboard nav via aria-activedescendant,
              // so there is no nested interactive button.
              return (
                <li
                  key={country.code}
                  id={optionId(country.code)}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => choose(country.code)}
                  onMouseMove={() => setActive(index)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-2 text-small",
                    isActive && "bg-accent text-accent-foreground",
                  )}
                >
                  <span className="line-clamp-1">{country.name}</span>
                  {isSelected && (
                    <CheckIcon className="size-4 shrink-0" strokeWidth={1.5} />
                  )}
                </li>
              );
            })
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
