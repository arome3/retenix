"use client";

import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

export const OTP_LENGTH = 6;

/*
 * Code entry for the branded OTP flow (doc 02 revision; DS S1). One input, not
 * six boxes: paste works, iOS one-time-code autofill works, and screen readers
 * get a single labeled field. Digits render in the data face (§3 — mono is the
 * verification-by-eye voice).
 */
export function OtpCodeInput({
  value,
  onChange,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (digits: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // The code is this screen's one job: take focus on arrival, and again after
  // a wrong code clears the field so retyping needs no pointer trip.
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled, invalid]);

  return (
    <div className="space-y-2">
      <label htmlFor="otp" className="block text-small text-muted-foreground">
        6-digit code
      </label>
      <Input
        ref={ref}
        id="otp"
        name="otp"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) =>
          onChange(event.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH))
        }
        className="tnum h-14 text-center font-mono text-h1 tracking-[0.35em]"
      />
    </div>
  );
}
